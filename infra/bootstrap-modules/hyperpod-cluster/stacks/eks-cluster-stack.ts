// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import { Construct } from 'constructs';

export interface MlccEksClusterStackProps extends cdk.StackProps {
    profileName: string;
    adoptEks?: boolean;
    adoptVpc?: boolean;
    adoptRoles?: boolean;
    vpcId?: string;
    eksClusterArn?: string;
    eksClusterName?: string;
    clusterSecurityGroupId?: string;
    privateSubnetIds?: string;
}

/**
 * Stack 1 of the HyperPod module: EKS cluster, VPC, IAM roles, and
 * dependency EKS add-ons required by the Inference Operator.
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
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod-cluster');
        cdk.Tags.of(this).add('mlcc:profile', profileName);
        cdk.Tags.of(this).add('mlcc:stack', 'eks-cluster');

        const ssmPrefix = `/mlcc/${profileName}/hyperpod`;

        // ─── VPC ────────────────────────────────────────────────────────────
        let vpc: ec2.IVpc;

        if (props.adoptVpc && props.vpcId) {
            vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
        } else {
            const newVpc = new ec2.Vpc(this, 'Vpc', {
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
            for (const subnet of newVpc.publicSubnets) {
                cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
            }
            for (const subnet of newVpc.privateSubnets) {
                cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
            }

            // S3 VPC Gateway endpoint on private route tables
            newVpc.addGatewayEndpoint('S3Endpoint', {
                service: ec2.GatewayVpcEndpointAwsService.S3,
                subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
            });

            newVpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
            vpc = newVpc;
        }

        const privateSubnetIds = vpc.privateSubnets.map(s => s.subnetId).join(',');

        new ssm.StringParameter(this, 'PrivateSubnetIdsParam', {
            parameterName: `${ssmPrefix}/PrivateSubnetIds`,
            stringValue: privateSubnetIds,
            description: 'Private subnet IDs for HyperPod EKS cluster',
        });

        // ─── IAM Roles (RemovalPolicy.RETAIN on all) ────────────────────────

        // EKS cluster role
        const eksClusterRole = this._createOrAdoptRole(
            'EksClusterRole',
            `mlcc-${profileName}-eks-cluster-role`,
            new iam.ServicePrincipal('eks.amazonaws.com'),
            ['arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'],
            props.adoptRoles,
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
            props.adoptRoles,
        );

        // HyperPod instance role
        const hyperpodInstanceRole = this._createOrAdoptRole(
            'HyperPodInstanceRole',
            `mlcc-${profileName}-hyperpod-instance-role`,
            new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            ['arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy'],
            props.adoptRoles,
        );

        // SageMaker assumes this role during CreateCluster to validate VpcConfig
        // subnets. AmazonSageMakerClusterInstanceRolePolicy does NOT include
        // EC2/VPC permissions, so we add them explicitly.
        if (!props.adoptRoles) {
            (hyperpodInstanceRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                sid: 'VpcSubnetAccess',
                effect: iam.Effect.ALLOW,
                actions: [
                    'ec2:DescribeSubnets',
                    'ec2:DescribeVpcs',
                    'ec2:DescribeSecurityGroups',
                    'ec2:DescribeNetworkInterfaces',
                    'ec2:CreateNetworkInterface',
                    'ec2:CreateNetworkInterfacePermission',
                    'ec2:DeleteNetworkInterface',
                    'ec2:DeleteNetworkInterfacePermission',
                    'ec2:DescribeDhcpOptions',
                ],
                resources: ['*'],
            }));
        }

        new ssm.StringParameter(this, 'HyperPodInstanceRoleArnParam', {
            parameterName: `${ssmPrefix}/HyperPodInstanceRoleArn`,
            stringValue: hyperpodInstanceRole.roleArn,
            description: 'HyperPod instance execution role ARN',
        });

        // ─── EKS Cluster ────────────────────────────────────────────────────
        let cluster: eks.ICluster;
        let clusterSecurityGroupId: string;

        if (props.adoptEks && props.eksClusterArn) {
            cluster = eks.Cluster.fromClusterAttributes(this, 'EksCluster', {
                clusterName: props.eksClusterName || props.eksClusterArn.split('/').pop()!,
                clusterSecurityGroupId: props.clusterSecurityGroupId,
                kubectlRoleArn: eksClusterRole.roleArn,
            });
            clusterSecurityGroupId = props.clusterSecurityGroupId || '';
        } else {
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

            clusterSecurityGroupId = newCluster.clusterSecurityGroupId;
            cluster = newCluster;

            // ─── Fargate Profile for system pods ────────────────────────────
            // Zero-node cluster needs Fargate to run webhook-serving pods
            // (cert-manager, ALB controller) so Helm installs and EKS addons
            // don't fail with "no endpoints available for service". Fargate is
            // pay-per-pod — ~$0.04/hr total for these tiny system pods.
            const fargateRoleName = `mlcc-${profileName}-fargate-pod-exec-role`;
            const fargateRole = props.adoptRoles
                ? iam.Role.fromRoleName(this, 'FargatePodExecutionRole', fargateRoleName)
                : new iam.Role(this, 'FargatePodExecutionRole', {
                    roleName: fargateRoleName,
                    assumedBy: new iam.ServicePrincipal('eks-fargate-pods.amazonaws.com'),
                    managedPolicies: [
                        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSFargatePodExecutionRolePolicy'),
                    ],
                });

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
                    { namespace: 'hyperpod-inference-system' },
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
            new eks.CfnAddon(this, 'S3CsiDriverAddon', {
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

            // HyperpodInferenceRole
            const hyperpodInferenceRole = this._createIrsaRole(
                'HyperpodInferenceRole',
                `mlcc-${profileName}-hyperpod-inference-role`,
                oidcProvider,
                'hyperpod-inference-system',
                'hyperpod-inference-controller-manager',
                ['arn:aws:iam::aws:policy/AmazonSageMakerHyperPodInferenceAccess'],
                props.adoptRoles,
            );

            // The inference operator calls UpdateClusterInference and passes its
            // own role ARN. The managed policy doesn't include iam:PassRole, so
            // we add it explicitly (self-referencing).
            if (!props.adoptRoles) {
                (hyperpodInferenceRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                    sid: 'PassSelfRole',
                    effect: iam.Effect.ALLOW,
                    actions: ['iam:PassRole'],
                    resources: [`arn:aws:iam::${this.account}:role/mlcc-${profileName}-hyperpod-inference-role`],
                }));
            }

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
                props.adoptRoles,
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
                props.adoptRoles,
            );

            // Add inline CloudWatch + APS read policies for KEDA
            if (!props.adoptRoles) {
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
            }

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
                props.adoptRoles,
            );

            if (!props.adoptRoles) {
                (s3CsiRole as iam.Role).addToPolicy(new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        's3:GetObject',
                        's3:PutObject',
                        's3:ListBucket',
                        's3:DeleteObject',
                        's3:GetBucketLocation',
                    ],
                    resources: [
                        `arn:aws:s3:::hyperpod-tls-*`,
                        `arn:aws:s3:::hyperpod-tls-*/*`,
                    ],
                }));
            }

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
                props.adoptRoles,
            );

            new ssm.StringParameter(this, 'FsxCsiRoleArnParam', {
                parameterName: `${ssmPrefix}/FsxCsiRoleArn`,
                stringValue: fsxCsiRole.roleArn,
            });
        }

        // ─── SSM Exports ────────────────────────────────────────────────────

        const eksClusterArn = props.adoptEks && props.eksClusterArn
            ? props.eksClusterArn
            : (cluster as eks.Cluster).clusterArn;

        const eksClusterName = props.adoptEks && props.eksClusterName
            ? props.eksClusterName
            : (cluster as eks.Cluster).clusterName;

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
     */
    private _createOrAdoptRole(
        id: string,
        roleName: string,
        principal: iam.IPrincipal,
        managedPolicyArns: string[],
        adopt?: boolean,
    ): iam.IRole {
        if (adopt) {
            return iam.Role.fromRoleName(this, id, roleName);
        }

        const role = new iam.Role(this, id, {
            roleName,
            assumedBy: principal,
            managedPolicies: managedPolicyArns.map(arn => iam.ManagedPolicy.fromManagedPolicyArn(this, `${id}Policy${managedPolicyArns.indexOf(arn)}`, arn)),
        });
        role.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        return role;
    }

    /**
     * Create or adopt an IRSA role with OIDC trust and RemovalPolicy.RETAIN.
     */
    private _createIrsaRole(
        id: string,
        roleName: string,
        oidcProvider: iam.IOpenIdConnectProvider,
        namespace: string,
        serviceAccount: string,
        managedPolicyArns: string[],
        adopt?: boolean,
    ): iam.IRole {
        if (adopt) {
            return iam.Role.fromRoleName(this, id, roleName);
        }

        const conditions = new cdk.CfnJson(this, `${id}Condition`, {
            value: {
                [`${oidcProvider.openIdConnectProviderIssuer}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
                [`${oidcProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
            },
        });

        const role = new iam.Role(this, id, {
            roleName,
            assumedBy: new iam.FederatedPrincipal(
                oidcProvider.openIdConnectProviderArn,
                { StringEquals: conditions },
                'sts:AssumeRoleWithWebIdentity',
            ),
            managedPolicies: managedPolicyArns.map(arn => iam.ManagedPolicy.fromManagedPolicyArn(this, `${id}ManagedPolicy${managedPolicyArns.indexOf(arn)}`, arn)),
        });
        role.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        return role;
    }
}
