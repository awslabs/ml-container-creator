// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import { Construct } from 'constructs';
import CORE_BUCKETS from '../../core/buckets.json';
import INFERENCE_OPERATOR_BUCKETS from '../../hyperpod/stacks/buckets.json';
import TRAINING_BUCKETS from '../../training/buckets.json';
import { renderBucketName } from '../../bucket-declarations';

export interface MlccEksClusterStackProps extends cdk.StackProps {
    profileName: string;
    /**
     * Adopt pre-existing IAM roles (via fromRoleName) instead of creating them. The
     * runner sets this when it detects the RETAIN'd roles survive from a prior deploy
     * (RemovalPolicy.RETAIN keeps them through teardown). The CLUSTER/VPC are NOT
     * RETAIN'd, so they are always created regardless of this flag. The OIDC export +
     * EksInferenceRole are created UNCONDITIONALLY (the real v1.9 fix — they must NOT be
     * gated behind create-vs-adopt).
     */
    adoptRoles?: boolean;
}

/**
 * The `eks` module's cluster stack (BL143 split): VPC, EKS cluster, OIDC provider,
 * Fargate, substrate add-ons, the EksInferenceRole (vanilla-EKS inference SA), and the
 * operator IRSA roles.
 *
 * HARD CUTOVER (BL143): this stack ALWAYS CREATES — the former
 * adoptEks/adoptVpc/adoptRoles branching is gone. The OIDC provider + EksInferenceRole
 * are therefore created unconditionally (killing the v1.9 create-only-branch trap).
 *
 * Option 2 note: the operator IRSA roles (ALB/KEDA/CSI/HyperpodInference) are created
 * HERE, coupled to the live cluster handle, rather than in a separate hyperpod stack
 * (which would require the risky fromClusterAttributes/imported-OIDC path). They are
 * only USED once the hyperpod module is added.
 */
export class MlccEksClusterStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccEksClusterStackProps) {
        super(scope, id, {
            ...props,
            terminationProtection: true,
        });

        const { profileName } = props;
        const region = this.region;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'eks');
        cdk.Tags.of(this).add('mlcc:profile', profileName);
        cdk.Tags.of(this).add('mlcc:stack', 'eks-cluster');

        const ssmPrefix = `/mlcc/${profileName}/hyperpod`;
        // Core models bucket name, rendered from its single declaration
        // (core/buckets.json) — the same string the core stack creates, so the
        // exact-ARN grants below are unchanged in the synthesized template.
        const coreBucketName = renderBucketName(
            CORE_BUCKETS.buckets.ModelsBucketResource,
            { account: this.account, region: this.region, profileName },
        );

        // ─── VPC (always created — hard cutover, no adopt path) ─────────────
        const vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 19,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 19,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Required subnet tags for ALB controller and internal load balancers
        for (const subnet of vpc.publicSubnets) {
            cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
        }
        for (const subnet of vpc.privateSubnets) {
            cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
        }

        // S3 VPC Gateway endpoint on private route tables
        vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        });

        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const privateSubnetIds = vpc.privateSubnets.map(s => s.subnetId).join(',');

        new ssm.StringParameter(this, 'PrivateSubnetIdsParam', {
            parameterName: `${ssmPrefix}/PrivateSubnetIds`,
            stringValue: privateSubnetIds,
            description: 'Private subnet IDs for HyperPod EKS cluster',
        });

        // ─── IAM Roles (RemovalPolicy.RETAIN on all) ────────────────────────

        // RETAIN'd IAM roles survive teardown, so a re-provision ADOPTS them (the runner
        // detects their existence and passes adoptRoles). The cluster/VPC are not
        // RETAIN'd and are always created below.
        const adoptRoles = props.adoptRoles === true;

        // EKS cluster role
        const eksClusterRole = this._createOrAdoptRole(
            'EksClusterRole',
            `mlcc-${profileName}-eks-cluster-role`,
            new iam.ServicePrincipal('eks.amazonaws.com'),
            ['arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'],
            adoptRoles,
        );

        // EKS node role
        const eksNodeRole = this._createOrAdoptRole(
            'EksNodeRole',
            `mlcc-${profileName}-eks-node-role`,
            new iam.ServicePrincipal('ec2.amazonaws.com'),
            [
                'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
                'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
                'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
            ],
            adoptRoles,
        );

        // HyperPod instance role
        const hyperpodInstanceRole = this._createOrAdoptRole(
            'HyperPodInstanceRole',
            `mlcc-${profileName}-hyperpod-instance-role`,
            new iam.CompositePrincipal(
                // SageMaker assumes this role during CreateCluster/UpdateCluster validation
                new iam.ServicePrincipal('sagemaker.amazonaws.com'),
                // EC2 assumes this role on the actual HyperPod node at runtime —
                // required for EKS-orchestrated clusters; without it HyperPod reports
                // "execution role permissions are invalid" and silently refuses to provision.
                new iam.ServicePrincipal('ec2.amazonaws.com'),
            ),
            [
                'arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy',
                // BL087: ECR read — aws-node + device plugin image pulls from EKS-managed ECR
                'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
                // BL087: VPC CNI — ipamd gRPC requires full ENI management
                'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
                // Required for EKS-orchestrated HyperPod: EC2 node registration with EKS
                'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
            ],
            adoptRoles,
        );

        // SageMaker assumes this role during CreateCluster to validate VpcConfig
        // subnets. AmazonSageMakerClusterInstanceRolePolicy does NOT include
        // the EC2 ENI permissions required for EKS-orchestrated clusters, so we
        // add them explicitly per the HyperPod EKS IAM prerequisites docs.
        //
        // BL143 adopt-drift fix: these inline policies are now asserted on BOTH the
        // create AND the adopt path (the role is imported mutably, so addToPrincipalPolicy
        // emits a real CFN policy against the existing role). Previously they were gated
        // behind `if (!adoptRoles)`, so an adopted role never gained them — the exact
        // drift that made HyperPod reject the role as "permissions invalid".
        hyperpodInstanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'HyperPodEksInstancePolicy',
            effect: iam.Effect.ALLOW,
            actions: [
                // ENI management — required for HyperPod to attach customer ENIs
                'ec2:AssignPrivateIpAddresses',
                'ec2:AttachNetworkInterface',
                'ec2:CreateNetworkInterface',
                'ec2:CreateNetworkInterfacePermission',
                'ec2:DeleteNetworkInterface',
                'ec2:DeleteNetworkInterfacePermission',
                'ec2:DetachNetworkInterface',
                'ec2:ModifyNetworkInterfaceAttribute',
                'ec2:UnassignPrivateIpAddresses',
                // Describe permissions
                'ec2:DescribeInstances',
                'ec2:DescribeInstanceTypes',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeTags',
                'ec2:DescribeVpcs',
                'ec2:DescribeDhcpOptions',
                'ec2:DescribeSubnets',
                'ec2:DescribeSecurityGroups',
                // ECR — pull container images (also covered by managed policy but explicit here)
                'ecr:BatchCheckLayerAvailability',
                'ecr:BatchGetImage',
                'ecr:GetAuthorizationToken',
                'ecr:GetDownloadUrlForLayer',
                // EKS Pod Identity (optional but included for completeness)
                'eks-auth:AssumeRoleForPodIdentity',
            ],
            resources: ['*'],
        }));
        // CreateTags scoped to network interfaces only
        hyperpodInstanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'HyperPodEksNetworkInterfaceTags',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:CreateTags'],
            resources: ['arn:aws:ec2:*:*:network-interface/*'],
        }));

        // BL087: S3 read access to the core models bucket (lifecycle script).
        // HyperPod nodes fetch on_create.sh from s3://<core bucket>/hyperpod-lifecycle/
        // at bootstrap time. Without this, nodes fail silently during provisioning.
        // Asserted on both create and adopt (see adopt-drift note above).
        hyperpodInstanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'HyperPodLifecycleS3Access',
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [
                `arn:aws:s3:::${coreBucketName}`,
                `arn:aws:s3:::${coreBucketName}/*`,
            ],
        }));

        new ssm.StringParameter(this, 'HyperPodInstanceRoleArnParam', {
            parameterName: `${ssmPrefix}/HyperPodInstanceRoleArn`,
            stringValue: hyperpodInstanceRole.roleArn,
            description: 'HyperPod instance execution role ARN',
        });

        // ─── EKS Cluster (always created — hard cutover, no adopt path) ─────
        const k8sVersion = this.node.tryGetContext('k8sVersion') || '1.31';

        const newCluster = new eks.Cluster(this, 'EksCluster', {
            version: eks.KubernetesVersion.of(k8sVersion),
            kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
            vpc,
            vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
            defaultCapacity: 0,
            role: eksClusterRole,
            authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
            clusterName: `mlcc-${profileName}-eks`,
        });

        const clusterSecurityGroupId = newCluster.clusterSecurityGroupId;

        {
            // ─── Fargate Profile for system pods ────────────────────────────
            // Zero-node cluster needs Fargate to run webhook-serving pods
            // (cert-manager, ALB controller) so Helm installs and EKS addons
            // don't fail with "no endpoints available for service". Fargate is
            // pay-per-pod — ~$0.04/hr total for these tiny system pods.
            const fargateRoleName = `mlcc-${profileName}-fargate-pod-exec-role`;
            // The role is RETAIN'd (survives teardown) → adopt it on re-provision; the
            // Fargate PROFILE below is always recreated (cluster-scoped).
            const fargateRole = adoptRoles
                ? iam.Role.fromRoleName(this, 'FargatePodExecutionRole', fargateRoleName)
                : new iam.Role(this, 'FargatePodExecutionRole', {
                    roleName: fargateRoleName,
                    assumedBy: new iam.ServicePrincipal('eks-fargate-pods.amazonaws.com'),
                    managedPolicies: [
                        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSFargatePodExecutionRolePolicy'),
                    ],
                });
            if (!adoptRoles) {
                // RETAIN so the Fargate profile's role ARN stays valid across rebuilds.
                (fargateRole as iam.Role).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
            }

            // Fargate profiles are cluster-scoped (not account-scoped like IAM
            // roles). When a cluster is recreated, the profile must also be
            // recreated — always create it regardless of adoptRoles.
            // NOTE: Fargate profiles support max 5 selectors. KEDA pods run in
            // hyperpod-inference-system so a separate keda selector is not needed.
            new eks.FargateProfile(this, 'SystemFargateProfile', {
                cluster: newCluster,
                fargateProfileName: `mlcc-${profileName}-system`,
                selectors: [
                    { namespace: 'kube-system' },
                    { namespace: 'cert-manager' },
                    { namespace: 'aws-hyperpod' },
                    // hyperpod-inference-system excluded: gateway-controller uses hostPath
                    // volumes unsupported by Fargate — must run on HyperPod EC2 worker nodes.
                    { namespace: 'kubeflow' },
                ],
                podExecutionRole: fargateRole,
            });

            // ─── EKS Add-ons ────────────────────────────────────────────────

            // Fargate toleration config — Fargate nodes have a taint that must be
            // tolerated for pods to schedule. Addons deployed as Deployments (not
            // DaemonSets) need this when running on a Fargate-only cluster.
            const fargateToleration = JSON.stringify({
                tolerations: [{
                    key: 'eks.amazonaws.com/compute-type',
                    operator: 'Equal',
                    value: 'fargate',
                    effect: 'NoSchedule',
                }],
            });

            // VPC-CNI ≥ v1.18.3 (HyperPod requirement) — runs as DaemonSet, no toleration needed
            new eks.CfnAddon(this, 'VpcCniAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'vpc-cni',
                addonVersion: 'v1.18.3-eksbuild.1',
                resolveConflicts: 'OVERWRITE',
            });

            // CoreDNS — Deployment, needs Fargate toleration
            // replicaCount: 1 to avoid pod scheduling issues during rolling updates on Fargate
            new eks.CfnAddon(this, 'CoreDnsAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'coredns',
                resolveConflicts: 'OVERWRITE',
                configurationValues: JSON.stringify({
                    computeType: 'Fargate',
                    replicaCount: 1,
                    tolerations: [{
                        key: 'eks.amazonaws.com/compute-type',
                        operator: 'Equal',
                        value: 'fargate',
                        effect: 'NoSchedule',
                    }],
                }),
            });

            // kube-proxy — DaemonSet, no toleration needed
            new eks.CfnAddon(this, 'KubeProxyAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'kube-proxy',
                resolveConflicts: 'OVERWRITE',
            });

            // ─── Dependency add-ons for Inference Operator ──────────────────

            // aws-mountpoint-s3-csi-driver ≥ v1.14.1-eksbuild.1 — DaemonSet, no toleration needed
            // Wave 6.1 R5.1: the add-on's controller SA is bound to S3CsiRole below
            // (serviceAccountRoleArn is set once the role exists). addonVersion is
            // deliberately unchanged — the v1→v2 bump is a separate change (D5).
            const s3CsiDriverAddon = new eks.CfnAddon(this, 'S3CsiDriverAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'aws-mountpoint-s3-csi-driver',
                addonVersion: 'v1.14.1-eksbuild.1',
                resolveConflicts: 'OVERWRITE',
            });

            // aws-fsx-csi-driver ≥ v1.6.0-eksbuild.1 — controller is a Deployment
            new eks.CfnAddon(this, 'FsxCsiDriverAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'aws-fsx-csi-driver',
                addonVersion: 'v1.6.0-eksbuild.1',
                resolveConflicts: 'OVERWRITE',
                configurationValues: JSON.stringify({
                    controller: {
                        tolerations: [{
                            key: 'eks.amazonaws.com/compute-type',
                            operator: 'Equal',
                            value: 'fargate',
                            effect: 'NoSchedule',
                        }],
                    },
                }),
            });

            // metrics-server ≥ v0.7.2-eksbuild.4 — Deployment, needs Fargate toleration
            new eks.CfnAddon(this, 'MetricsServerAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'metrics-server',
                addonVersion: 'v0.7.2-eksbuild.4',
                resolveConflicts: 'OVERWRITE',
                configurationValues: fargateToleration,
            });

            // cert-manager ≥ v1.18.2-eksbuild.2 — Deployments, needs Fargate toleration
            // replicaCount: 1 per component to avoid rolling update scheduling issues
            new eks.CfnAddon(this, 'CertManagerAddon', {
                clusterName: newCluster.clusterName,
                addonName: 'cert-manager',
                addonVersion: 'v1.18.2-eksbuild.2',
                resolveConflicts: 'OVERWRITE',
                configurationValues: JSON.stringify({
                    replicaCount: 1,
                    tolerations: [{
                        key: 'eks.amazonaws.com/compute-type',
                        operator: 'Equal',
                        value: 'fargate',
                        effect: 'NoSchedule',
                    }],
                    webhook: {
                        replicaCount: 1,
                        tolerations: [{
                            key: 'eks.amazonaws.com/compute-type',
                            operator: 'Equal',
                            value: 'fargate',
                            effect: 'NoSchedule',
                        }],
                    },
                    cainjector: {
                        replicaCount: 1,
                        tolerations: [{
                            key: 'eks.amazonaws.com/compute-type',
                            operator: 'Equal',
                            value: 'fargate',
                            effect: 'NoSchedule',
                        }],
                    },
                }),
            });

            // NVIDIA device plugin via addManifest
            newCluster.addManifest('NvidiaDevicePlugin', {
                apiVersion: 'apps/v1',
                kind: 'DaemonSet',
                metadata: {
                    name: 'nvidia-device-plugin-daemonset',
                    namespace: 'kube-system',
                },
                spec: {
                    selector: { matchLabels: { name: 'nvidia-device-plugin-ds' } },
                    updateStrategy: { type: 'RollingUpdate' },
                    template: {
                        metadata: { labels: { name: 'nvidia-device-plugin-ds' } },
                        spec: {
                            tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }],
                            priorityClassName: 'system-node-critical',
                            containers: [{
                                image: 'nvcr.io/nvidia/k8s-device-plugin:v0.14.5',
                                name: 'nvidia-device-plugin-ctr',
                                env: [{ name: 'FAIL_ON_INIT_ERROR', value: 'false' }],
                                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
                                volumeMounts: [{ name: 'device-plugin', mountPath: '/var/lib/kubelet/device-plugins' }],
                            }],
                            volumes: [{ name: 'device-plugin', hostPath: { path: '/var/lib/kubelet/device-plugins' } }],
                        },
                    },
                },
            });

            // ─── IRSA Roles ─────────────────────────────────────────────────

            const oidcProvider = newCluster.openIdConnectProvider;

            // ─── EksInferenceRole (vanilla-EKS inference SA) ────────────────
            // The role a plain-EKS inference pod assumes to read an S3-staged model.
            // Namespace-WILDCARD sub (so it works across deploy namespaces) + fixed SA
            // name `mlcc-eks-inference-sa`. Created UNCONDITIONALLY here (BL143 — this is
            // the "redo properly in the eks module" item; the v1.9 version was gated
            // behind a create-only adopt branch and silently skipped on adopt). Exported
            // as eksInferenceRoleArn → consumed by do/deploy.d/eks via
            // _PROFILE_eksInferenceRoleArn.
            const eksInferenceRoleName = `mlcc-${profileName}-eks-inference-role`;
            const eksInferenceCondition = new cdk.CfnJson(this, 'EksInferenceRoleCondition', {
                value: {
                    [`${oidcProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
                },
            });
            const eksInferenceRole = new iam.Role(this, 'EksInferenceRole', {
                roleName: eksInferenceRoleName,
                assumedBy: new iam.FederatedPrincipal(
                    oidcProvider.openIdConnectProviderArn,
                    {
                        StringEquals: eksInferenceCondition,
                        // namespace-wildcard sub: any namespace, fixed SA name.
                        StringLike: new cdk.CfnJson(this, 'EksInferenceRoleSub', {
                            value: {
                                [`${oidcProvider.openIdConnectProviderIssuer}:sub`]:
                                    'system:serviceaccount:*:mlcc-eks-inference-sa',
                            },
                        }),
                    },
                    'sts:AssumeRoleWithWebIdentity',
                ),
            });
            eksInferenceRole.addToPolicy(new iam.PolicyStatement({
                sid: 'EksInferenceS3Read',
                effect: iam.Effect.ALLOW,
                actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
                resources: [
                    `arn:aws:s3:::${coreBucketName}`,
                    `arn:aws:s3:::${coreBucketName}/*`,
                ],
            }));
            // DESTROY (not RETAIN): OIDC-bound, recreated with the cluster.
            eksInferenceRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

            new ssm.StringParameter(this, 'EksInferenceRoleArnParam', {
                parameterName: `${ssmPrefix}/EksInferenceRoleArn`,
                stringValue: eksInferenceRole.roleArn,
                description: 'EKS inference IRSA role ARN (vanilla-EKS S3-staged model access)',
            });
            new cdk.CfnOutput(this, 'EksInferenceRoleArnOutput', {
                value: eksInferenceRole.roleArn,
                exportName: `mlcc-${profileName}-eks-EksInferenceRoleArn`,
            });

            // OIDC provider exports — the eks module publishes these so any consumer
            // (and a future hyperpod stack, if it ever imports the cluster) can resolve
            // the provider. Created unconditionally (no adopt branch).
            new ssm.StringParameter(this, 'OidcProviderArnParam', {
                parameterName: `${ssmPrefix}/OidcProviderArn`,
                stringValue: oidcProvider.openIdConnectProviderArn,
                description: 'EKS OIDC provider ARN',
            });
            new ssm.StringParameter(this, 'OidcProviderIssuerParam', {
                parameterName: `${ssmPrefix}/OidcProviderIssuer`,
                stringValue: oidcProvider.openIdConnectProviderIssuer,
                description: 'EKS OIDC provider issuer URL',
            });
            new cdk.CfnOutput(this, 'OidcProviderArnOutput', {
                value: oidcProvider.openIdConnectProviderArn,
                exportName: `mlcc-${profileName}-eks-OidcProviderArn`,
            });
            new cdk.CfnOutput(this, 'OidcProviderIssuerOutput', {
                value: oidcProvider.openIdConnectProviderIssuer,
                exportName: `mlcc-${profileName}-eks-OidcProviderIssuer`,
            });

            // HyperpodInferenceRole
            const hyperpodInferenceRole = this._createIrsaRole(
                'HyperpodInferenceRole',
                `mlcc-${profileName}-hyperpod-inference-role`,
                oidcProvider,
                'hyperpod-inference-system',
                'hyperpod-inference-controller-manager',
                ['arn:aws:iam::aws:policy/AmazonSageMakerHyperPodInferenceAccess'],
            );

            // The inference operator calls UpdateClusterInference and passes its
            // own role ARN. The managed policy doesn't include iam:PassRole, so
            // we add it explicitly (self-referencing). IRSA roles are always created
            // (DESTROY), so this inline policy is unconditional.
            (hyperpodInferenceRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                sid: 'PassSelfRole',
                effect: iam.Effect.ALLOW,
                actions: ['iam:PassRole'],
                resources: [`arn:aws:iam::${this.account}:role/mlcc-${profileName}-hyperpod-inference-role`],
            }));

            // The inference operator writes/reads TLS material in its TLS bucket
            // (declared in hyperpod/stacks/buckets.json, created by the inference-operator stack)
            // and performs an S3 "dry-run" PutObject at startup to validate access.
            // AmazonSageMakerHyperPodInferenceAccess does NOT grant write to this
            // bucket, so the operator fails with:
            //   AccessDenied ... s3:PutObject ... <tls bucket>/inference-operator-s3-dryrun
            // Grant it explicitly by ARN (the bucket name is declared, so no
            // cross-stack import is needed — the bucket lives in a later stack).
            // Inference Operator v3.0 tags the ALB, S3, and ACM resources it creates
            // (per the HyperPod Inference release notes). Its TLS dry-run writes a
            // TAGGED object to the TLS bucket, so the role needs BOTH
            // s3:PutObject AND s3:PutObjectTagging (a tagged PutObject without the latter
            // fails AccessDenied on s3:PutObjectTagging). PutObject/GetObject/ListBucket
            // cover the read/write of TLS material; PutObjectTagging matches AWS's
            // documented `S3PutObjectTaggingAccess` statement.
            const tlsBucketName = renderBucketName(
                INFERENCE_OPERATOR_BUCKETS.buckets.TlsBucket,
                { account: this.account, region: this.region, profileName },
            );
            (hyperpodInferenceRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                sid: 'HyperPodInferenceTlsBucketAccess',
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:PutObject',
                    's3:PutObjectTagging',
                    's3:GetObject',
                    's3:ListBucket',
                ],
                resources: [
                    `arn:aws:s3:::${tlsBucketName}`,
                    `arn:aws:s3:::${tlsBucketName}/*`,
                ],
            }));

            // The operator also tags the ACM certificate it provisions for the ALB
            // (same v3.0 tagging change). Without this it fails AccessDenied on
            // acm:AddTagsToCertificate. Matches AWS's `CertificateTagginPermission`.
            (hyperpodInferenceRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                sid: 'HyperPodInferenceCertTagging',
                effect: iam.Effect.ALLOW,
                actions: ['acm:AddTagsToCertificate'],
                resources: ['arn:aws:acm:*:*:certificate/*'],
            }));

            new ssm.StringParameter(this, 'HyperpodInferenceRoleArnParam', {
                parameterName: `${ssmPrefix}/HyperpodInferenceRoleArn`,
                stringValue: hyperpodInferenceRole.roleArn,
            });

            // AlbControllerRole — AWS does not ship a managed policy for the ALB
            // controller. We create the customer-managed policy from the official
            // iam_policy.json (v2.14.1) as a CDK resource, then attach it via IRSA.
            const albPolicy = new iam.ManagedPolicy(this, 'AlbControllerPolicy', {
                managedPolicyName: `mlcc-${profileName}-alb-controller-policy`,
                statements: [
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['iam:CreateServiceLinkedRole'],
                        resources: ['*'],
                        conditions: {
                            StringEquals: { 'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com' },
                        },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: [
                            'ec2:DescribeAccountAttributes', 'ec2:DescribeAddresses',
                            'ec2:DescribeAvailabilityZones', 'ec2:DescribeInternetGateways',
                            'ec2:DescribeVpcs', 'ec2:DescribeVpcPeeringConnections',
                            'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups',
                            'ec2:DescribeInstances', 'ec2:DescribeNetworkInterfaces',
                            'ec2:DescribeTags', 'ec2:GetCoipPoolUsage',
                            'ec2:DescribeCoipPools', 'ec2:GetSecurityGroupsForVpc',
                            'ec2:DescribeIpamPools', 'ec2:DescribeRouteTables',
                            'elasticloadbalancing:DescribeLoadBalancers',
                            'elasticloadbalancing:DescribeLoadBalancerAttributes',
                            'elasticloadbalancing:DescribeListeners',
                            'elasticloadbalancing:DescribeListenerCertificates',
                            'elasticloadbalancing:DescribeSSLPolicies',
                            'elasticloadbalancing:DescribeRules',
                            'elasticloadbalancing:DescribeTargetGroups',
                            'elasticloadbalancing:DescribeTargetGroupAttributes',
                            'elasticloadbalancing:DescribeTargetHealth',
                            'elasticloadbalancing:DescribeTags',
                            'elasticloadbalancing:DescribeTrustStores',
                            'elasticloadbalancing:DescribeListenerAttributes',
                            'elasticloadbalancing:DescribeCapacityReservation',
                        ],
                        resources: ['*'],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: [
                            'cognito-idp:DescribeUserPoolClient',
                            'acm:ListCertificates', 'acm:DescribeCertificate',
                            'iam:ListServerCertificates', 'iam:GetServerCertificate',
                            'waf-regional:GetWebACL', 'waf-regional:GetWebACLForResource',
                            'waf-regional:AssociateWebACL', 'waf-regional:DisassociateWebACL',
                            'wafv2:GetWebACL', 'wafv2:GetWebACLForResource',
                            'wafv2:AssociateWebACL', 'wafv2:DisassociateWebACL',
                            'shield:GetSubscriptionState', 'shield:DescribeProtection',
                            'shield:CreateProtection', 'shield:DeleteProtection',
                        ],
                        resources: ['*'],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'],
                        resources: ['*'],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['ec2:CreateSecurityGroup'],
                        resources: ['*'],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['ec2:CreateTags'],
                        resources: ['arn:aws:ec2:*:*:security-group/*'],
                        conditions: {
                            StringEquals: { 'ec2:CreateAction': 'CreateSecurityGroup' },
                            Null: { 'aws:RequestTag/elbv2.k8s.aws/cluster': 'false' },
                        },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['ec2:CreateTags', 'ec2:DeleteTags'],
                        resources: ['arn:aws:ec2:*:*:security-group/*'],
                        conditions: {
                            Null: {
                                'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
                                'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
                            },
                        },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress', 'ec2:DeleteSecurityGroup'],
                        resources: ['*'],
                        conditions: { Null: { 'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false' } },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:CreateTargetGroup'],
                        resources: ['*'],
                        conditions: { Null: { 'aws:RequestTag/elbv2.k8s.aws/cluster': 'false' } },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: [
                            'elasticloadbalancing:CreateListener', 'elasticloadbalancing:DeleteListener',
                            'elasticloadbalancing:CreateRule', 'elasticloadbalancing:DeleteRule',
                        ],
                        resources: ['*'],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'],
                        resources: [
                            'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
                            'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
                            'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
                        ],
                        conditions: {
                            Null: {
                                'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
                                'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
                            },
                        },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'],
                        resources: [
                            'arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*',
                            'arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*',
                            'arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*',
                            'arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*',
                        ],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: [
                            'elasticloadbalancing:ModifyLoadBalancerAttributes',
                            'elasticloadbalancing:SetIpAddressType',
                            'elasticloadbalancing:SetSecurityGroups',
                            'elasticloadbalancing:SetSubnets',
                            'elasticloadbalancing:DeleteLoadBalancer',
                            'elasticloadbalancing:ModifyTargetGroup',
                            'elasticloadbalancing:ModifyTargetGroupAttributes',
                            'elasticloadbalancing:DeleteTargetGroup',
                            'elasticloadbalancing:ModifyListenerAttributes',
                            'elasticloadbalancing:ModifyCapacityReservation',
                            'elasticloadbalancing:ModifyIpPools',
                        ],
                        resources: ['*'],
                        conditions: { Null: { 'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false' } },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['elasticloadbalancing:AddTags'],
                        resources: [
                            'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
                            'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
                            'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
                        ],
                        conditions: {
                            StringEquals: {
                                'elasticloadbalancing:CreateAction': ['CreateTargetGroup', 'CreateLoadBalancer'],
                            },
                            Null: { 'aws:RequestTag/elbv2.k8s.aws/cluster': 'false' },
                        },
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ['elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets'],
                        resources: ['arn:aws:elasticloadbalancing:*:*:targetgroup/*/*'],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: [
                            'elasticloadbalancing:SetWebAcl', 'elasticloadbalancing:ModifyListener',
                            'elasticloadbalancing:AddListenerCertificates',
                            'elasticloadbalancing:RemoveListenerCertificates',
                            'elasticloadbalancing:ModifyRule', 'elasticloadbalancing:SetRulePriorities',
                        ],
                        resources: ['*'],
                    }),
                ],
            });

            const albControllerRole = this._createIrsaRole(
                'AlbControllerRole',
                `mlcc-${profileName}-alb-controller-role`,
                oidcProvider,
                'kube-system',
                'aws-load-balancer-controller',
                [albPolicy.managedPolicyArn],
                // Trust the SA name in ANY namespace: this stack installs the ALB
                // controller in kube-system, but the HyperPod Inference Operator add-on
                // runs its own ALB controller in hyperpod-inference-system under the same
                // SA name and annotates it with THIS role. A kube-system-only pin rejects
                // the operator-namespace token (sub mismatch → AssumeRoleWithWebIdentity
                // 403), which hangs the InferenceEndpointConfig forever.
                true,
            );

            new ssm.StringParameter(this, 'AlbControllerRoleArnParam', {
                parameterName: `${ssmPrefix}/AlbControllerRoleArn`,
                stringValue: albControllerRole.roleArn,
            });

            // AWS Load Balancer Controller Helm chart
            newCluster.addHelmChart('AwsLoadBalancerController', {
                chart: 'aws-load-balancer-controller',
                repository: 'https://aws.github.io/eks-charts',
                namespace: 'kube-system',
                release: 'aws-load-balancer-controller',
                values: {
                    clusterName: newCluster.clusterName,
                    // Fargate nodes don't expose IMDS, so VPC ID must be explicit
                    vpcId: vpc.vpcId,
                    region: this.region,
                    serviceAccount: {
                        create: true,
                        name: 'aws-load-balancer-controller',
                        annotations: {
                            'eks.amazonaws.com/role-arn': albControllerRole.roleArn,
                        },
                    },
                },
            });

            // KedaOperatorRole
            const kedaOperatorRole = this._createIrsaRole(
                'KedaOperatorRole',
                `mlcc-${profileName}-keda-operator-role`,
                oidcProvider,
                'keda',
                'keda-operator',
                [],
            );

            // Add inline CloudWatch + APS read policies for KEDA (IRSA role always created).
            (kedaOperatorRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'cloudwatch:GetMetricData',
                    'cloudwatch:GetMetricStatistics',
                    'cloudwatch:ListMetrics',
                    'cloudwatch:DescribeAlarms',
                    'aps:QueryMetrics',
                    'aps:GetLabels',
                    'aps:GetSeries',
                    'aps:GetMetricMetadata',
                ],
                resources: ['*'],
            }));

            new ssm.StringParameter(this, 'KedaOperatorRoleArnParam', {
                parameterName: `${ssmPrefix}/KedaOperatorRoleArn`,
                stringValue: kedaOperatorRole.roleArn,
            });

            // S3CsiRole
            const s3CsiRole = this._createIrsaRole(
                'S3CsiRole',
                `mlcc-${profileName}-s3-csi-role`,
                oidcProvider,
                'kube-system',
                's3-csi-driver-sa',
                [],
            );

            // Wave 6.1 R5.2: TLS material in MLCC's REAL TLS bucket (the former
            // 'hyperpod-tls-*' pattern never matched MLCC's own TLS bucket name),
            // name rendered from its single declaration (hyperpod/stacks/buckets.json).
            const csiTlsBucketName = renderBucketName(
                INFERENCE_OPERATOR_BUCKETS.buckets.TlsBucket,
                { account: this.account, region: this.region, profileName },
            );
            (s3CsiRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                sid: 'S3CsiTlsBucketAccess',
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:GetObject',
                    's3:PutObject',
                    's3:ListBucket',
                    's3:DeleteObject',
                    's3:GetBucketLocation',
                ],
                resources: [
                    `arn:aws:s3:::${csiTlsBucketName}`,
                    `arn:aws:s3:::${csiTlsBucketName}/*`,
                ],
            }));

            // Wave 6.1 R5.2: READ the model mounts — the core models bucket (staged
            // base models and, under Option D, their canonical .mlcc-adapters/) and
            // the legacy training / adapters buckets (recorded URIs). Names rendered
            // from core/buckets.json and training/buckets.json — never spelled here.
            const csiReadBuckets = [
                coreBucketName,
                renderBucketName(TRAINING_BUCKETS.buckets.TrainingBucket,
                    { account: this.account, region: this.region, profileName }),
                renderBucketName(TRAINING_BUCKETS.buckets.AdaptersBucket,
                    { account: this.account, region: this.region, profileName }),
            ];
            (s3CsiRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                sid: 'S3CsiModelBucketsRead',
                effect: iam.Effect.ALLOW,
                actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
                resources: csiReadBuckets.flatMap(b => [`arn:aws:s3:::${b}`, `arn:aws:s3:::${b}/*`]),
            }));

            // Wave 6.1 R5.1: attach the role to the add-on (an in-place
            // AWS::EKS::Addon update — no replacement; R5.3).
            s3CsiDriverAddon.serviceAccountRoleArn = s3CsiRole.roleArn;

            new ssm.StringParameter(this, 'S3CsiRoleArnParam', {
                parameterName: `${ssmPrefix}/S3CsiRoleArn`,
                stringValue: s3CsiRole.roleArn,
            });

            // FsxCsiRole
            const fsxCsiRole = this._createIrsaRole(
                'FsxCsiRole',
                `mlcc-${profileName}-fsx-csi-role`,
                oidcProvider,
                'kube-system',
                'fsx-csi-controller-sa',
                ['arn:aws:iam::aws:policy/AmazonFSxFullAccess'],
            );

            new ssm.StringParameter(this, 'FsxCsiRoleArnParam', {
                parameterName: `${ssmPrefix}/FsxCsiRoleArn`,
                stringValue: fsxCsiRole.roleArn,
            });
        }

        // ─── SSM Exports ────────────────────────────────────────────────────

        const eksClusterArn = newCluster.clusterArn;
        const eksClusterName = newCluster.clusterName;

        new ssm.StringParameter(this, 'EksClusterArnParam', {
            parameterName: `${ssmPrefix}/EksClusterArn`,
            stringValue: eksClusterArn,
            description: 'EKS cluster ARN for HyperPod',
        });

        new ssm.StringParameter(this, 'EksClusterNameParam', {
            parameterName: `${ssmPrefix}/EksClusterName`,
            stringValue: eksClusterName,
            description: 'EKS cluster name for HyperPod',
        });

        new ssm.StringParameter(this, 'ClusterSecurityGroupIdParam', {
            parameterName: `${ssmPrefix}/ClusterSecurityGroupId`,
            stringValue: clusterSecurityGroupId,
            description: 'EKS cluster security group ID',
        });

        // ─── CfnOutputs ────────────────────────────────────────────────────

        new cdk.CfnOutput(this, 'EksClusterArnOutput', {
            value: eksClusterArn,
            exportName: `mlcc-${profileName}-eks-EksClusterArn`,
        });

        new cdk.CfnOutput(this, 'EksClusterNameOutput', {
            value: eksClusterName,
            exportName: `mlcc-${profileName}-eks-EksClusterName`,
        });

        new cdk.CfnOutput(this, 'ClusterSecurityGroupIdOutput', {
            value: clusterSecurityGroupId,
            exportName: `mlcc-${profileName}-eks-ClusterSecurityGroupId`,
        });

        new cdk.CfnOutput(this, 'PrivateSubnetIdsOutput', {
            value: privateSubnetIds,
            exportName: `mlcc-${profileName}-eks-PrivateSubnetIds`,
        });
    }

    /**
     * Create or adopt an IAM role with RemovalPolicy.RETAIN.
     *
     * ADOPT PATH (BL143 adopt-drift fix): a RETAIN'd service role that already exists
     * is IMPORTED, not recreated — but it is imported with `mutable: true` and its
     * managed policies are RE-ASSERTED so a `bootstrap update` CONVERGES the live role
     * to the current spec. The earlier bug was importing via `fromRoleName()` (which
     * yields an IMMUTABLE handle whose addManagedPolicy/addToPolicy calls are silent
     * no-ops) and skipping the managed/inline attachments on adopt — so an adopted role
     * stayed frozen at whatever it had when first created, drifting out of spec and
     * making HyperPod reject it with "execution role permissions are invalid".
     *
     * CAVEAT — TRUST POLICY: CDK cannot modify the assume-role (trust) policy of an
     * IMPORTED role. The `principal` here only takes effect on the CREATE path. For an
     * adopted role, the trust principal (e.g. the ec2.amazonaws.com principal the
     * HyperPod instance role needs) must be reconciled out-of-band at provision time
     * (the same seam that applies VpcSubnetAccess in module-runner.cjs). Policies DO
     * converge here; trust does not.
     */
    private _createOrAdoptRole(
        id: string,
        roleName: string,
        principal: iam.IPrincipal,
        managedPolicyArns: string[],
        adopt?: boolean,
    ): iam.IRole {
        if (adopt) {
            // Mutable import so INLINE policy statements (addToPrincipalPolicy, added by
            // the caller) emit a real standalone Policy attached to the existing role.
            // NOTE: CDK CANNOT attach a MANAGED policy to an imported role —
            // addManagedPolicy(fromManagedPolicyArn(...)) is refused with
            // "Can't combine imported IManagedPolicy ... Use ManagedPolicy directly" and
            // silently does nothing. So managed-policy reconciliation for an adopted role
            // is NOT attempted here; it is done at provision time by the module runner
            // (_ensureHyperPodInstanceRoleManagedPolicies), the same seam that reconciles
            // the trust policy and VpcSubnetAccess. (BL143 adopt-drift.)
            const roleArn = `arn:aws:iam::${this.account}:role/${roleName}`;
            return iam.Role.fromRoleArn(this, id, roleArn, { mutable: true });
        }

        // Reference AWS-managed policies by NAME (fromAwsManagedPolicyName), not by
        // imported ARN (fromManagedPolicyArn). The name form yields an ATTACHABLE
        // ManagedPolicy; the ARN form yields an imported IManagedPolicy that CDK refuses
        // to attach to an imported role ("Can't combine imported IManagedPolicy ... Use
        // ManagedPolicy directly"). All callers pass arn:aws:iam::aws:policy/<Name>, so
        // the name is the ARN suffix. Using the name form keeps create robust and
        // warning-free and is the correct API if these are ever attached post-import.
        const role = new iam.Role(this, id, {
            roleName,
            assumedBy: principal,
            managedPolicies: managedPolicyArns.map(arn =>
                iam.ManagedPolicy.fromAwsManagedPolicyName(arn.replace('arn:aws:iam::aws:policy/', '')),
            ),
        });
        role.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        return role;
    }

    /**
     * Create an IRSA role with OIDC trust and RemovalPolicy.DESTROY.
     *
     * IRSA roles are BOUND to this cluster's OIDC provider. The cluster/OIDC are not
     * RETAIN'd (recreated fresh on every provision), so an IRSA role is meaningless once
     * the cluster is gone — and a RETAIN'd one would (a) collide on recreate and (b) carry
     * trust pointing at the DELETED OIDC. So these are DESTROY and ALWAYS created (never
     * adopted): they must be recreated to trust the NEW OIDC issuer. (This is the
     * correctness fix from the first live bring-up — Option 1.)
     */
    private _createIrsaRole(
        id: string,
        roleName: string,
        oidcProvider: iam.IOpenIdConnectProvider,
        namespace: string,
        serviceAccount: string,
        managedPolicyArns: string[],
        // When true, trust the SA by NAME in ANY namespace (StringLike wildcard on the
        // namespace segment) instead of pinning the exact namespace. Needed when the
        // workload's runtime namespace is NOT controlled by this stack — e.g. the ALB
        // controller: this stack's Helm chart installs it in kube-system, but the
        // HyperPod Inference Operator add-on installs ITS OWN ALB controller in
        // hyperpod-inference-system under the same SA name and annotates it with THIS
        // role. A StringEquals pin to kube-system rejects that operator-namespace token
        // (sub mismatch) → AssumeRoleWithWebIdentity 403 → the ALB never provisions and
        // the InferenceEndpointConfig hangs at DeploymentInProgress. Trusting the SA name
        // in any namespace covers whichever controller actually serves the ingress.
        saNameAnyNamespace = false,
    ): iam.IRole {
        const subClaim = `${oidcProvider.openIdConnectProviderIssuer}:sub`;
        const audClaim = `${oidcProvider.openIdConnectProviderIssuer}:aud`;

        // aud is always an exact match; sub is either exact (default) or a name-anywhere
        // wildcard. CfnJson is required because the issuer URL is only known at deploy
        // time (it is a token), so the condition keys cannot be literals.
        const audCondition = new cdk.CfnJson(this, `${id}Aud`, {
            value: { [audClaim]: 'sts.amazonaws.com' },
        });
        const subCondition = new cdk.CfnJson(this, `${id}Sub`, {
            value: {
                [subClaim]: saNameAnyNamespace
                    ? `system:serviceaccount:*:${serviceAccount}`
                    : `system:serviceaccount:${namespace}:${serviceAccount}`,
            },
        });

        const role = new iam.Role(this, id, {
            roleName,
            assumedBy: new iam.FederatedPrincipal(
                oidcProvider.openIdConnectProviderArn,
                saNameAnyNamespace
                    ? { StringEquals: audCondition, StringLike: subCondition }
                    : { StringEquals: new cdk.CfnJson(this, `${id}Condition`, {
                        value: {
                            [subClaim]: `system:serviceaccount:${namespace}:${serviceAccount}`,
                            [audClaim]: 'sts.amazonaws.com',
                        },
                    }) },
                'sts:AssumeRoleWithWebIdentity',
            ),
            managedPolicies: managedPolicyArns.map(arn => iam.ManagedPolicy.fromManagedPolicyArn(this, `${id}ManagedPolicy${managedPolicyArns.indexOf(arn)}`, arn)),
        });
        // DESTROY (not RETAIN): OIDC-bound, dies with the cluster, recreated cleanly.
        role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        return role;
    }
}
