// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK Stack Unit Tests for HyperPod module stacks.
 *
 * Uses source analysis to verify resource creation, removal policies,
 * and configuration without deploying to AWS.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// BL143: eks-cluster → eks/stacks/; hyperpod-cluster + inference-operator → hyperpod/stacks/.
const BOOTSTRAP = resolve(__dirname, '../../infra/bootstrap-modules');
const EKS_CLUSTER_STACK = resolve(BOOTSTRAP, 'eks/stacks/eks-cluster-stack.ts');
const HYPERPOD_CLUSTER_STACK = resolve(BOOTSTRAP, 'hyperpod/stacks/hyperpod-cluster-stack.ts');
const INFERENCE_OPERATOR_STACK = resolve(BOOTSTRAP, 'hyperpod/stacks/inference-operator-stack.ts');
const MODULES_ROOT = BOOTSTRAP;
// The TLS bucket's single declaration (bucket consolidation R1.2) — the name contract
// these source checks guard now lives here, not as a literal in the stacks.
const TLS_DECLARATION = JSON.parse(
    readFileSync(resolve(BOOTSTRAP, 'hyperpod/stacks/buckets.json'), 'utf8')
).buckets.TlsBucket;

describe('HyperPod CDK Stack Files', () => {
    describe('Stack file existence', () => {
        it('eks-cluster-stack.ts exists', () => {
            assert.ok(existsSync(EKS_CLUSTER_STACK));
        });

        it('hyperpod-cluster-stack.ts exists', () => {
            assert.ok(existsSync(HYPERPOD_CLUSTER_STACK));
        });

        it('inference-operator-stack.ts exists', () => {
            assert.ok(existsSync(INFERENCE_OPERATOR_STACK));
        });
    });

    describe('EKS Cluster Stack (source analysis)', () => {
        const source = readFileSync(EKS_CLUSTER_STACK, 'utf8');

        it('creates VPC with 2 AZs', () => {
            assert.ok(source.includes('maxAzs: 2'), 'Should have maxAzs: 2');
        });

        it('creates public and private subnets', () => {
            assert.ok(source.includes('SubnetType.PUBLIC'), 'Should have public subnets');
            assert.ok(source.includes('PRIVATE_WITH_EGRESS'), 'Should have private subnets with NAT');
        });

        it('tags subnets for ELB/ALB controller', () => {
            assert.ok(source.includes('kubernetes.io/role/elb'), 'Public subnets tagged for ELB');
            assert.ok(source.includes('kubernetes.io/role/internal-elb'), 'Private subnets tagged for internal ELB');
        });

        it('creates S3 VPC Gateway endpoint', () => {
            assert.ok(source.includes('GatewayVpcEndpointAwsService.S3'));
        });

        it('creates EKS cluster with API_AND_CONFIG_MAP auth', () => {
            assert.ok(source.includes('AuthenticationMode.API_AND_CONFIG_MAP'));
        });

        it('installs vpc-cni addon at v1.18.3', () => {
            assert.ok(source.includes('vpc-cni'));
            assert.ok(source.includes('v1.18.3'));
        });

        it('installs coredns addon', () => {
            assert.ok(source.includes('addonName: \'coredns\''));
        });

        it('installs kube-proxy addon', () => {
            assert.ok(source.includes('addonName: \'kube-proxy\''));
        });

        it('installs aws-mountpoint-s3-csi-driver addon', () => {
            assert.ok(source.includes('aws-mountpoint-s3-csi-driver'));
            assert.ok(source.includes('v1.14.1-eksbuild.1'));
        });

        it('installs aws-fsx-csi-driver addon', () => {
            assert.ok(source.includes('aws-fsx-csi-driver'));
            assert.ok(source.includes('v1.6.0-eksbuild.1'));
        });

        it('installs metrics-server addon', () => {
            assert.ok(source.includes('metrics-server'));
            assert.ok(source.includes('v0.7.2-eksbuild.4'));
        });

        it('installs cert-manager addon', () => {
            assert.ok(source.includes('cert-manager'));
            assert.ok(source.includes('v1.18.2-eksbuild.2'));
        });

        it('installs NVIDIA device plugin via addManifest', () => {
            assert.ok(source.includes('NvidiaDevicePlugin'));
            assert.ok(source.includes('k8s-device-plugin:v0.14.5'));
        });

        it('installs AWS Load Balancer Controller Helm chart', () => {
            assert.ok(source.includes('aws-load-balancer-controller'));
            assert.ok(source.includes('addHelmChart'));
        });

        it('creates EKS cluster role with AmazonEKSClusterPolicy', () => {
            assert.ok(source.includes('AmazonEKSClusterPolicy'));
            assert.ok(source.includes('eks-cluster-role'));
        });

        it('creates EKS node role with required policies', () => {
            assert.ok(source.includes('AmazonEKSWorkerNodePolicy'));
            assert.ok(source.includes('AmazonEC2ContainerRegistryReadOnly'));
            assert.ok(source.includes('AmazonEKS_CNI_Policy'));
        });

        it('creates HyperPod instance role', () => {
            assert.ok(source.includes('AmazonSageMakerClusterInstanceRolePolicy'));
            assert.ok(source.includes('hyperpod-instance-role'));
        });

        describe('HyperPod instance role IAM requirements (BL087)', () => {
            const hyperpodRoleStart = source.indexOf('// HyperPod instance role');
            const hyperpodRoleEnd = source.indexOf('new ssm.StringParameter(this, \'HyperPodInstanceRoleArnParam\'');
            const hyperpodRoleSource = source.slice(hyperpodRoleStart, hyperpodRoleEnd);

            it('trusts both SageMaker and EC2', () => {
                assert.match(
                    hyperpodRoleSource,
                    /new iam\.CompositePrincipal\([\s\S]*?new iam\.ServicePrincipal\('sagemaker\.amazonaws\.com'\),[\s\S]*?new iam\.ServicePrincipal\('ec2\.amazonaws\.com'\)/
                );
            });

            it('attaches all required AWS-managed policies', () => {
                for (const policyName of [
                    'AmazonSageMakerClusterInstanceRolePolicy',
                    'AmazonEC2ContainerRegistryReadOnly',
                    'AmazonEKS_CNI_Policy',
                    'AmazonEKSWorkerNodePolicy'
                ]) {
                    assert.ok(
                        hyperpodRoleSource.includes(policyName),
                        `HyperPod instance role must attach ${policyName}`
                    );
                }
            });

            it('grants the HyperPod lifecycle bucket read access', () => {
                const policyStart = hyperpodRoleSource.indexOf('sid: \'HyperPodLifecycleS3Access\'');
                const policyEnd = hyperpodRoleSource.indexOf('}));', policyStart);
                const lifecyclePolicy = hyperpodRoleSource.slice(policyStart, policyEnd);

                assert.ok(lifecyclePolicy.includes('\'s3:GetObject\''));
                assert.ok(lifecyclePolicy.includes('\'s3:ListBucket\''));
                // Bucket consolidation R2: the core bucket name is rendered from its one
                // declaration (core/buckets.json), never spelled out in the stack.
                assert.ok(lifecyclePolicy.includes('arn:aws:s3:::${coreBucketName}'));
                assert.ok(lifecyclePolicy.includes('arn:aws:s3:::${coreBucketName}/*'));
                assert.match(source, /const coreBucketName = renderBucketName\(\s*CORE_BUCKETS\.buckets\.ModelsBucketResource/);
            });

            it('grants HyperPod ENI management permissions', () => {
                const policyStart = hyperpodRoleSource.indexOf('sid: \'HyperPodEksInstancePolicy\'');
                const policyEnd = hyperpodRoleSource.indexOf('}));', policyStart);
                const eniPolicy = hyperpodRoleSource.slice(policyStart, policyEnd);

                assert.ok(eniPolicy.includes('\'ec2:CreateNetworkInterface\''));
                assert.ok(eniPolicy.includes('\'ec2:AttachNetworkInterface\''));
            });

            // BL143 adopt-drift regression guards. The failure these prevent: the ENI
            // and lifecycle-S3 inline policies were gated behind `if (!adoptRoles)`, so
            // an ADOPTED instance role never gained them and HyperPod rejected it with
            // "execution role permissions are invalid". The policies must now be asserted
            // on BOTH paths (no adoptRoles guard), and the adopt import must be MUTABLE
            // so the re-asserted policies actually emit against the existing role.
            it('does NOT gate the ENI/S3 inline policies behind an adoptRoles check', () => {
                // The inline policy attachments must not sit inside an `if (!adoptRoles)`
                // block — that was the drift bug. They should be unconditional.
                assert.ok(
                    !/if \(!adoptRoles\) \{[\s\S]*?HyperPodEksInstancePolicy/.test(hyperpodRoleSource),
                    'HyperPodEksInstancePolicy must not be gated behind if (!adoptRoles)'
                );
                assert.ok(
                    !/if \(!adoptRoles\) \{[\s\S]*?HyperPodLifecycleS3Access/.test(hyperpodRoleSource),
                    'HyperPodLifecycleS3Access must not be gated behind if (!adoptRoles)'
                );
                // And they must still be present (asserted on every path).
                assert.ok(hyperpodRoleSource.includes('HyperPodEksInstancePolicy'));
                assert.ok(hyperpodRoleSource.includes('HyperPodLifecycleS3Access'));
            });

            it('imports an adopted role mutably so re-asserted policies converge', () => {
                // _createOrAdoptRole adopt branch must use fromRoleArn(..., { mutable: true })
                // — fromRoleName() yields an immutable handle whose policy adds are no-ops.
                const helperStart = source.indexOf('private _createOrAdoptRole');
                const helperEnd = source.indexOf('private _createIrsaRole');
                const helper = source.slice(helperStart, helperEnd);
                assert.ok(
                    /fromRoleArn\([\s\S]*?\{ mutable: true \}\)/.test(helper),
                    'adopt path must import with fromRoleArn(..., { mutable: true })'
                );
                assert.ok(
                    !/iam\.Role\.fromRoleName\(/.test(helper),
                    'adopt path must NOT use the immutable iam.Role.fromRoleName() import'
                );
                // CDK cannot attach a MANAGED policy to an imported role (it warns
                // "Can't combine imported IManagedPolicy ... Use ManagedPolicy directly"
                // and no-ops). So the adopt branch must NOT call addManagedPolicy — that
                // reconciliation is deferred to the provision-time runner seam.
                assert.ok(
                    !/adopted\.addManagedPolicy\(/.test(helper),
                    'adopt path must NOT addManagedPolicy on an imported role (CDK no-ops it)'
                );
            });

            it('retains the Fargate pod execution role', () => {
                const fargateRoleStart = source.indexOf('const fargateRoleName');
                const fargateRoleEnd = source.indexOf('new eks.FargateProfile(this, \'SystemFargateProfile\'');
                const fargateRoleSource = source.slice(fargateRoleStart, fargateRoleEnd);

                assert.ok(
                    fargateRoleSource.includes('(fargateRole as iam.Role).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN)'),
                    'Fargate pod execution role must be retained on stack deletion'
                );
            });
        });

        it('creates all 5 IRSA roles', () => {
            assert.ok(source.includes('HyperpodInferenceRole'));
            assert.ok(source.includes('AlbControllerRole'));
            assert.ok(source.includes('KedaOperatorRole'));
            assert.ok(source.includes('S3CsiRole'));
            assert.ok(source.includes('FsxCsiRole'));
        });

        it('trusts the ALB controller SA in ANY namespace (operator runs it outside kube-system)', () => {
            // The HyperPod Inference Operator installs its OWN ALB controller in
            // hyperpod-inference-system under SA aws-load-balancer-controller, annotated
            // with alb-controller-role. A kube-system-only StringEquals :sub pin rejects
            // that token (AssumeRoleWithWebIdentity 403), hanging the InferenceEndpointConfig.
            // So the AlbControllerRole _createIrsaRole call must pass saNameAnyNamespace=true.
            // The AlbControllerRole _createIrsaRole call must end with `true` (the
            // saNameAnyNamespace flag) as its final positional arg.
            const callStart = source.indexOf('this._createIrsaRole(\n                \'AlbControllerRole\'');
            assert.ok(callStart > -1, 'AlbControllerRole must be created via _createIrsaRole');
            const callSlice = source.slice(callStart, source.indexOf(');', callStart));
            assert.ok(
                /\btrue,?\s*$/.test(callSlice.trimEnd()),
                'AlbControllerRole must pass saNameAnyNamespace=true as the final arg'
            );
            // And the helper must emit a StringLike wildcard sub for that mode.
            assert.ok(
                source.includes('system:serviceaccount:*:${serviceAccount}'),
                'saNameAnyNamespace must produce a StringLike sub wildcard on the namespace'
            );
        });

        it('keeps the other IRSA roles pinned to their exact namespace (no wildcard)', () => {
            // Only the ALB role needs the any-namespace trust; the inference/keda/csi roles
            // run where the stack expects, so they stay exact to avoid over-broad trust.
            for (const call of ['HyperpodInferenceRole', 'KedaOperatorRole', 'S3CsiRole', 'FsxCsiRole']) {
                const i = source.indexOf(`'${call}'`);
                const slice = source.slice(i, i + 500);
                assert.ok(
                    !/\btrue,\s*\n\s*\);/.test(slice),
                    `${call} must NOT request saNameAnyNamespace (stays exact-namespace pinned)`
                );
            }
        });

        it('grants the inference role tagged-write access to its TLS bucket', () => {
            // Inference Operator v3.0 tags S3 objects, so its dry-run writes a TAGGED
            // object to mlcc-hyperpod-tls-<profile> — needs BOTH s3:PutObject AND
            // s3:PutObjectTagging (else AccessDenied on s3:PutObjectTagging). The managed
            // policy AmazonSageMakerHyperPodInferenceAccess does not cover this bucket.
            const sidStart = source.indexOf('sid: \'HyperPodInferenceTlsBucketAccess\'');
            assert.ok(sidStart > -1, 'HyperPodInferenceTlsBucketAccess policy must exist');
            const policy = source.slice(sidStart, source.indexOf('}));', sidStart));
            assert.ok(policy.includes('\'s3:PutObject\''), 'must allow s3:PutObject');
            assert.ok(policy.includes('\'s3:PutObjectTagging\''), 'must allow s3:PutObjectTagging (v3.0 tagging)');
            assert.ok(policy.includes('tlsBucketName'), 'scoped to the TLS bucket (tlsBucketName)');
            // Bucket consolidation R2: rendered from the inference-operator stack's one
            // declaration (hyperpod/stacks/buckets.json), not a spelled-out literal.
            assert.match(source, /const tlsBucketName = renderBucketName\(\s*INFERENCE_OPERATOR_BUCKETS\.buckets\.TlsBucket/,
                'tlsBucketName must be rendered from the TlsBucket declaration');
            assert.equal(TLS_DECLARATION.name, 'mlcc-hyperpod-tls-{profile}',
                'the declared TLS bucket name must stay mlcc-hyperpod-tls-<profile>');
        });

        it('grants the inference role ACM certificate tagging', () => {
            // v3.0 also tags the ACM cert for the ALB (acm:AddTagsToCertificate).
            const sidStart = source.indexOf('sid: \'HyperPodInferenceCertTagging\'');
            assert.ok(sidStart > -1, 'HyperPodInferenceCertTagging policy must exist');
            const policy = source.slice(sidStart, source.indexOf('}));', sidStart));
            assert.ok(policy.includes('\'acm:AddTagsToCertificate\''), 'must allow acm:AddTagsToCertificate');
        });

        it('splits removal policy: service roles RETAIN (adopt), IRSA/OIDC-bound DESTROY', () => {
            // Service roles (eksCluster/eksNode/hyperpodInstance/fargate) survive teardown
            // and are adopted on re-provision → RETAIN. IRSA roles + EksInferenceRole are
            // OIDC-bound (recreated with the cluster) → DESTROY. (Option 1 fix.)
            assert.ok(source.includes('RemovalPolicy.RETAIN'), 'service roles RETAIN');
            // _createIrsaRole helper flips to DESTROY.
            assert.ok(/IRSA role[\s\S]*?RemovalPolicy\.DESTROY|DESTROY.*OIDC-bound/.test(source),
                'IRSA roles DESTROY');
            assert.ok(/eksInferenceRole\.applyRemovalPolicy\(cdk\.RemovalPolicy\.DESTROY\)/.test(source),
                'EksInferenceRole DESTROY');
        });

        it('enables terminationProtection on the stack', () => {
            assert.ok(source.includes('terminationProtection: true'));
        });

        it('exports SSM params for cluster info', () => {
            assert.ok(source.includes('/EksClusterArn'));
            assert.ok(source.includes('/EksClusterName'));
            assert.ok(source.includes('/ClusterSecurityGroupId'));
            assert.ok(source.includes('/PrivateSubnetIds'));
            assert.ok(source.includes('/HyperPodInstanceRoleArn'));
        });

        it('exports IRSA role ARNs as SSM params', () => {
            assert.ok(source.includes('/HyperpodInferenceRoleArn'));
            assert.ok(source.includes('/AlbControllerRoleArn'));
            assert.ok(source.includes('/KedaOperatorRoleArn'));
            assert.ok(source.includes('/S3CsiRoleArn'));
            assert.ok(source.includes('/FsxCsiRoleArn'));
        });

        it('cluster/VPC always create (no adoptEks/adoptVpc); roles adopt via adoptRoles', () => {
            // Hard cutover for the CLUSTER + VPC (not RETAIN'd — recreated fresh), so no
            // adoptEks/adoptVpc. But the SERVICE ROLES are RETAIN'd and survive teardown,
            // so adoptRoles IS supported (Option 1 — the first live bring-up proved
            // "always create" collides with the retained roles).
            assert.ok(!/props\.adoptEks/.test(source), 'props.adoptEks removed (cluster always creates)');
            assert.ok(!/props\.adoptVpc/.test(source), 'props.adoptVpc removed (VPC always creates)');
            assert.ok(/props\.adoptRoles/.test(source), 'adoptRoles supported for RETAINed service roles');
            assert.ok(!/eks\.Cluster\.fromClusterAttributes\(/.test(source),
                'no imported-cluster path (fromClusterAttributes call)');
        });

        it('creates the EksInferenceRole + OIDC exports unconditionally (BL143)', () => {
            assert.ok(source.includes('EksInferenceRole'), 'EksInferenceRole present');
            assert.ok(source.includes('mlcc-eks-inference-sa'), 'namespace-wildcard inference SA');
            assert.ok(source.includes('OidcProviderArn'), 'OIDC provider ARN exported');
            assert.ok(source.includes('OidcProviderIssuer'), 'OIDC issuer exported');
        });

        it('has VPC RemovalPolicy.DESTROY', () => {
            assert.ok(source.includes('RemovalPolicy.DESTROY'));
        });

        it('sets default K8s version to 1.31', () => {
            assert.ok(source.includes('\'1.31\''));
        });

        it('sets default capacity to 0 (no managed node groups)', () => {
            assert.ok(source.includes('defaultCapacity: 0'));
        });
    });

    describe('HyperPod Cluster Stack (source analysis)', () => {
        const source = readFileSync(HYPERPOD_CLUSTER_STACK, 'utf8');

        it('creates CfnCluster (native CloudFormation resource)', () => {
            assert.ok(source.includes('CfnCluster'));
        });

        it('default-worker group has a 2-instance floor (BL143 — setup requires it)', () => {
            // A 0-instance EKS-orchestrated HyperPod cluster does not finish setup;
            // the default-worker floor is 2 (overridable via defaultWorkerCount, not below 2).
            assert.ok(source.includes('tryGetContext(\'defaultWorkerCount\')'), 'overridable count');
            assert.ok(source.includes('|| 2'), 'floor defaults to 2');
            assert.ok(!/instanceCount: 0\b/.test(source), 'no longer 0-instance');
        });

        it('uses a CPU default instance type for the operator floor (ml.c5.4xlarge)', () => {
            // The default-worker floor runs the operator's CPU control-plane pods — it
            // must NOT default to a GPU instance. GPU compute is attached on demand via
            // separate instance groups. (BL143 — CPU-floor change, live-validated.)
            assert.ok(
                source.includes('|| \'ml.c5.4xlarge\''),
                'default-worker must default to the CPU ml.c5.4xlarge (AWS operator minimum)'
            );
            assert.ok(
                !source.includes('|| \'ml.g5.2xlarge\''),
                'default-worker must NOT default to a GPU instance type'
            );
        });

        it('sets instanceGroupName to default-worker', () => {
            assert.ok(source.includes('default-worker'));
        });

        it('sets orchestrator.eks.clusterArn from context', () => {
            assert.ok(source.includes('clusterArn'));
            assert.ok(source.includes('eksClusterArn'));
        });

        it('sets vpcConfig with private subnets and security group', () => {
            assert.ok(source.includes('vpcConfig'));
            assert.ok(source.includes('privateSubnetIds'));
            assert.ok(source.includes('clusterSecurityGroupId'));
        });

        it('sets nodeRecovery: Automatic', () => {
            assert.ok(source.includes('nodeRecovery: \'Automatic\''));
        });

        it('applies RemovalPolicy.DESTROY on CfnCluster', () => {
            assert.ok(source.includes('cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)'));
        });

        it('exports HyperPodClusterArn and HyperPodClusterName as SSM params', () => {
            assert.ok(source.includes('/HyperPodClusterArn'));
            assert.ok(source.includes('/HyperPodClusterName'));
        });

        it('accepts required cluster inputs from props or context', () => {
            assert.ok(source.includes('props.eksClusterArn'));
            assert.ok(source.includes('this.node.tryGetContext(\'EksClusterArn\')'));
            assert.ok(source.includes('props.hyperPodInstanceRoleArn'));
        });

        it('returns an empty stack when EksClusterArn is unavailable during destroy', () => {
            assert.match(source, /if \(!eksClusterArn\) \{\s*return;\s*\}/);
        });

        it('does NOT use AwsCustomResource', () => {
            assert.ok(!source.includes('AwsCustomResource'));
        });
    });

    describe('Inference Operator Stack (source analysis)', () => {
        const source = readFileSync(INFERENCE_OPERATOR_STACK, 'utf8');

        it('creates TLS S3 bucket with correct naming', () => {
            // Name comes from the declaration (bucket consolidation R2), not a literal.
            assert.equal(TLS_DECLARATION.name, 'mlcc-hyperpod-tls-{profile}');
            assert.match(source, /renderBucketName\(\s*bucketDeclaration\(BUCKETS, 'TlsBucket'\)/);
            assert.ok(source.includes('TlsBucket'));
        });

        it('applies RemovalPolicy.RETAIN on TLS bucket', () => {
            assert.ok(source.includes('RemovalPolicy.RETAIN'));
        });

        it('sets autoDeleteObjects: false on bucket', () => {
            assert.ok(source.includes('autoDeleteObjects: false'));
        });

        it('declares the inference add-on as a CDK-owned eks.CfnAddon (BL161)', () => {
            // BL161: the add-on moved from an out-of-band `aws eks create-addon`
            // module-runner step into a CDK resource, mirroring the four sibling
            // eks.CfnAddon declarations in eks-cluster-stack.ts. Source-analysis assertion
            // (no cdk synth), consistent with how the sibling add-ons are tested.
            assert.match(source, /new eks\.CfnAddon\(/);
            assert.ok(
                source.includes('addonName: \'amazon-sagemaker-hyperpod-inference\''),
                'the CfnAddon must declare addonName amazon-sagemaker-hyperpod-inference'
            );
            assert.ok(
                source.includes('resolveConflicts: \'OVERWRITE\''),
                'the CfnAddon must resolve conflicts with OVERWRITE (like the sibling add-ons)'
            );
            // The imperative install hook must be GONE — the add-on is not CLI-installed.
            assert.ok(
                !source.includes('_installInferenceAddon'),
                'the stack must no longer defer to the imperative _installInferenceAddon'
            );
        });

        it('reads inference operator inputs from props or context', () => {
            assert.ok(source.includes('props.hyperPodClusterArn'));
            assert.ok(source.includes('this.node.tryGetContext(\'HyperPodClusterArn\')'));
            assert.ok(source.includes('props.hyperpodInferenceRoleArn'));
            assert.ok(source.includes('props.albControllerRoleArn'));
            assert.ok(source.includes('props.kedaOperatorRoleArn'));
        });

        it('allows an empty HyperPodClusterArn during stack destruction', () => {
            assert.match(source, /if \(!hyperPodClusterArn\) \{\s*return;\s*\}/);
        });

        it('configures add-on with ALB role', () => {
            assert.ok(source.includes('albControllerRoleArn'));
        });

        it('configures add-on with KEDA role', () => {
            assert.ok(source.includes('kedaOperatorRoleArn'));
        });

        it('builds the add-on config from stack inputs, preserving the jumpstart conditional', () => {
            // R1/R3: the config blob the imperative path assembled now lives in the stack,
            // sourced from props/context (no runtime SSM read).
            assert.ok(source.includes('configurationValues: JSON.stringify('));
            assert.ok(source.includes('executionRoleArn'));
            assert.ok(source.includes('inferenceGateway: { enabled: false }'));
            // The jumpstart role is included ONLY when present (empty would fail the
            // IAM-ARN pattern validation) — the conditional must be preserved.
            assert.ok(
                /if \(jumpstartGatedRoleArn\) \{\s*inferenceConfig\.jumpstartGatedModelDownloadRoleArn/.test(source),
                'jumpstartGatedModelDownloadRoleArn must be conditionally included only when present'
            );
        });

        it('passes the TLS bucket name into the add-on config explicitly (naming-audit guard, R4)', () => {
            // ADR-012 Q3 corollary drift guard: the mlcc-hyperpod-tls-<profile> bucket is
            // referenced by its EXPLICIT name in the add-on configurationValues, NOT
            // resolved by a sagemaker-/hyperpod- prefix convention. If a future change
            // switched to prefix-based resolution, this assertion fails loudly.
            assert.match(source, /const bucketName = renderBucketName\(\s*bucketDeclaration\(BUCKETS, 'TlsBucket'\)/,
                'TLS bucket name must be rendered from the TlsBucket declaration');
            assert.equal(TLS_DECLARATION.name, 'mlcc-hyperpod-tls-{profile}',
                'the declared TLS bucket name must stay mlcc-hyperpod-tls-<profile>');
            assert.ok(
                source.includes('tlsCertificateS3Bucket: bucketName'),
                'the add-on config must pass the bucket name explicitly as tlsCertificateS3Bucket'
            );
        });

        it('exports InferenceOperatorStatus as SSM param', () => {
            assert.ok(source.includes('/InferenceOperatorStatus'));
        });

        it('supports adopt-existing TLS bucket', () => {
            // Adoption goes through the shared declaredBucket helper (which owns the
            // fromBucketName / new-Bucket choice), keyed by the declared adopt context.
            assert.ok(source.includes('adoptTlsBucket'));
            assert.equal(TLS_DECLARATION.adoptContext, 'adoptTlsBucket');
            assert.match(source, /declaredBucket\(this, 'TlsBucket', bucketName, props\.adoptTlsBucket/);
            assert.ok(readFileSync(resolve(MODULES_ROOT, 'bucket-declarations.ts'), 'utf8').includes('fromBucketName'));
        });

        it('supports adopt-existing inference addon', () => {
            assert.ok(source.includes('adoptInferenceAddon'));
        });

        it('returns an empty stack when HyperPodClusterArn is unavailable during destroy', () => {
            assert.match(source, /if \(!hyperPodClusterArn\) \{\s*return;\s*\}/);
        });
    });
});

// BL143 adopt-drift fix — provision-time reconciliation of ALL adopted service roles.
// CDK cannot set the trust policy of, or attach a managed policy to, an ADOPTED
// (imported) role. So the module runner reconciles trust + managed policies for every
// RETAIN'd service role at provision time (after the eks-cluster stack deploys). Without
// this, an adopted role drifts out of spec — e.g. the HyperPod instance role missing the
// ec2 trust principal fails CreateCluster with "execution role permissions are invalid".
describe('Module runner reconciles ALL adopted service roles (adopt-drift)', () => {
    const RUNNER = resolve(BOOTSTRAP, 'module-runner.cjs');
    const source = readFileSync(RUNNER, 'utf8');

    // The four RETAIN'd service roles the eks-cluster stack creates/adopts, with their
    // _createOrAdoptRole call markers in the stack (used by the drift guard below).
    const ADOPTED_ROLES = [
        { suffix: 'eks-cluster-role', call: '\'EksClusterRole\'', principals: ['eks.amazonaws.com'] },
        { suffix: 'eks-node-role', call: '\'EksNodeRole\'', principals: ['ec2.amazonaws.com'] },
        { suffix: 'hyperpod-instance-role', call: '\'HyperPodInstanceRole\'', principals: ['sagemaker.amazonaws.com', 'ec2.amazonaws.com'] },
        { suffix: 'fargate-pod-exec-role', call: null, principals: ['eks-fargate-pods.amazonaws.com'] } // Fargate role is inline, not via _createOrAdoptRole
    ];

    it('defines a single generalized reconciler', () => {
        assert.ok(
            source.includes('_ensureAdoptedServiceRoles(profile)'),
            'module-runner must define _ensureAdoptedServiceRoles'
        );
        // The old single-role methods must be gone (folded into the generalized one).
        assert.ok(!source.includes('_ensureHyperPodInstanceRoleTrust'), 'old trust method removed');
        assert.ok(!source.includes('_ensureHyperPodInstanceRoleManagedPolicies'), 'old managed method removed');
    });

    it('reconciles both trust (update-assume-role-policy) and managed policies (attach-role-policy)', () => {
        const start = source.indexOf('_ensureAdoptedServiceRoles(profile) {');
        const body = source.slice(start, start + 3000);
        assert.ok(body.includes('update-assume-role-policy'), 'must reconcile trust');
        assert.ok(body.includes('attach-role-policy'), 'must reconcile managed policies');
    });

    it('is invoked after the eks-cluster stack deploys (before hyperpod CreateCluster)', () => {
        assert.ok(
            /stackSuffix === 'eks-cluster'[\s\S]*?this\._ensureAdoptedServiceRoles\(profile\)/.test(source),
            'the reconciler must be called in the eks-cluster provision block'
        );
    });

    it('does not depend on _iamRoleExists (which lives on a different class)', () => {
        const start = source.indexOf('_ensureAdoptedServiceRoles(profile) {');
        const body = source.slice(start, start + 3000);
        assert.ok(!body.includes('this._iamRoleExists'), 'must use an inline get-role check');
    });

    it('covers all four adopted service roles', () => {
        const start = source.indexOf('const ADOPTED_SERVICE_ROLES = [');
        const table = source.slice(start, source.indexOf('];', start));
        for (const r of ADOPTED_ROLES) {
            assert.ok(table.includes(`'${r.suffix}'`), `ADOPTED_SERVICE_ROLES must include ${r.suffix}`);
        }
    });

    // derive-dont-hardcode drift guard: for every role that the stack creates via
    // _createOrAdoptRole, the runner's ADOPTED_SERVICE_ROLES managedPolicies must match
    // the stack's managed-policy array exactly. (The Fargate role is created inline, not
    // via _createOrAdoptRole, so its single managed policy is checked by membership.)
    it('runner managed-policy lists mirror the stack per role', () => {
        const eksSource = readFileSync(EKS_CLUSTER_STACK, 'utf8');
        const tableStart = source.indexOf('const ADOPTED_SERVICE_ROLES = [');
        const table = source.slice(tableStart, source.indexOf('];', tableStart));

        for (const r of ADOPTED_ROLES) {
            // Extract the runner entry's managedPolicies for this suffix.
            const entryStart = table.indexOf(`suffix: '${r.suffix}'`);
            const entry = table.slice(entryStart, table.indexOf('},', entryStart));
            const runnerArns = [...entry.matchAll(/arn:aws:iam::aws:policy\/[A-Za-z0-9_]+/g)]
                .map(m => m[0]).sort();
            assert.ok(runnerArns.length > 0, `runner entry ${r.suffix} must list managed policies`);

            if (r.call) {
                // Stack side: slice the _createOrAdoptRole(...) call for this role.
                const callStart = eksSource.indexOf(`this._createOrAdoptRole(\n            ${r.call}`);
                assert.ok(callStart > -1, `stack must create ${r.suffix} via _createOrAdoptRole`);
                const callSlice = eksSource.slice(callStart, eksSource.indexOf('adoptRoles,', callStart));
                const stackArns = [...callSlice.matchAll(/arn:aws:iam::aws:policy\/[A-Za-z0-9_]+/g)]
                    .map(m => m[0]).sort();
                assert.deepStrictEqual(
                    runnerArns, stackArns,
                    `runner managedPolicies for ${r.suffix} must mirror the stack exactly`
                );
            }
        }
    });

    // BL143 live-rehearsal finding: the SageMaker endpoint-creation stage is gated on the
    // the HyperPod cluster being inference-enabled. SIGNAL CORRECTED (BL143, 2026-10-15):
    // the live rehearsal proved `describe-cluster InferenceConfig` stays null even when the
    // operator's watcher IS Enabled — the two are decoupled, so the verifier now gates on the
    // OPERATOR'S watcher status (its log line), NOT InferenceConfig. The check is read-only
    // and non-fatal (a warning, never an exit).
    it('verifies cluster inference enablement via the operator watcher status (NOT InferenceConfig)', () => {
        assert.ok(
            source.includes('_ensureHyperPodClusterInferenceEnabled'),
            'module-runner must define _ensureHyperPodClusterInferenceEnabled'
        );
        const start = source.indexOf('_ensureHyperPodClusterInferenceEnabled(profile) {');
        const body = source.slice(start, start + 2800);
        // Must read the OPERATOR watcher status (via kubectl controller logs), not the
        // decoupled describe-cluster InferenceConfig field.
        assert.ok(body.includes('hyperpod-inference-controller-manager'),
            'must read the operator controller-manager (watcher status), not describe-cluster');
        assert.ok(/watcher/i.test(body), 'must gate on the operator watcher status');
        assert.ok(!/--query "InferenceConfig"/.test(body),
            'must NOT gate on describe-cluster InferenceConfig (confirmed decoupled / red herring)');
        // BL161: the verifier runs as a post-deploy step (after the stack loop installs the
        // CDK-owned add-on), via _postDeployInferenceOperator — not from the removed
        // imperative _installInferenceAddon.
        assert.ok(
            /_postDeployInferenceOperator\(profile\) \{[\s\S]*?this\._ensureHyperPodClusterInferenceEnabled\(profile\)/.test(source),
            'the watcher verifier must run from the post-deploy step'
        );
    });

    it('watcher-verification poll window covers the documented enablement duration (>10 min)', () => {
        // The read-only watcher check uses a 25-min window (recreate drains can push
        // EnableClusterInference success past 15 min); it must not regress to the old
        // too-short 10-min (600000) poll.
        assert.ok(
            !source.includes('const timeout = 600000;'),
            'watcher poll must not use the too-short 10-min (600000) timeout'
        );
    });

    it('post-install patches write their own eks kubeconfig (not a guessed path)', () => {
        // The patches target the operator on the EKS cluster; the runner must create a
        // kubeconfig for that cluster via update-kubeconfig rather than assuming a path
        // another step wrote (the old `.kube/hyperpod-<profileName>` guess did not exist
        // and every patch failed). BL143 live-rehearsal finding.
        const start = source.indexOf('_postInstallInferenceOperator(profile, hyperpodClusterArn) {');
        const body = source.slice(start, start + 1200);
        assert.ok(
            body.includes('aws eks update-kubeconfig'),
            '_postInstallInferenceOperator must write a kubeconfig via update-kubeconfig'
        );
        assert.ok(
            !body.includes('.kube/hyperpod-${profile.profileName}'),
            'must not reuse the broken `.kube/hyperpod-<profileName>` guessed path'
        );
    });

    it('teardown removes the inference add-on via CDK destroy, not an out-of-band delete (BL161)', () => {
        // BL161: the add-on is now a CDK-owned eks.CfnAddon in the inference-operator
        // stack, so the normal reverse `cdk destroy` removes it with its stack. The old
        // out-of-band `aws eks delete-addon` hook (and the stale-ARN wedge it papered over)
        // must be GONE — create and destroy are now symmetric.
        assert.ok(
            !source.includes('_deleteInferenceAddon'),
            'the imperative _deleteInferenceAddon hook must be removed (teardown is CDK-owned)'
        );
        assert.ok(
            !/aws eks delete-addon/.test(source),
            'teardown must not issue an out-of-band aws eks delete-addon'
        );
        // The CDK side owns the add-on lifecycle: the inference-operator stack declares it.
        const stackSource = readFileSync(INFERENCE_OPERATOR_STACK, 'utf8');
        assert.match(stackSource, /new eks\.CfnAddon\(/);
        assert.ok(
            stackSource.includes('addonName: \'amazon-sagemaker-hyperpod-inference\''),
            'the inference-operator stack must declare the CDK-owned add-on'
        );
    });
});

// BL143 finding #11: the hyperpod-eks deploy driver must NOT gate DEPLOYMENT_TARGET_HP_STATUS
// =Running on the managed SageMaker endpoint reaching InService. The live rehearsal proved a
// correctly-serving model (pod healthy, ALB up, /ping 200) does NOT get a SageMaker endpoint
// created by the operator (an operator/control-plane issue outside MLCC). Gating Running on
// describe-endpoint InService therefore reported Failed for a working deployment. The endpoint
// is now an advisory sub-status (HP_SAGEMAKER_ENDPOINT_STATUS), never a gate.
describe('hyperpod-eks deploy driver — Running decoupled from SageMaker endpoint (finding #11)', () => {
    const DRIVER = resolve(BOOTSTRAP, '../../templates/do/deploy.d/hyperpod-eks');
    const source = readFileSync(DRIVER, 'utf8');

    it('does NOT exit/Fail the deploy when the SageMaker endpoint is absent', () => {
        // Isolate the endpoint-poll block (advisory) through to the Running write.
        const start = source.indexOf('Poll the SageMaker endpoint');
        assert.ok(start > -1, 'endpoint-poll block must be present');
        const end = source.indexOf('DEPLOYMENT_TARGET_HP_STATUS" "Running"', start);
        assert.ok(end > -1, 'Running write must follow the endpoint poll');
        const block = source.slice(start, end);
        // The endpoint poll must NOT exit or mark Failed on a missing/non-InService endpoint.
        assert.ok(!/_update_config "DEPLOYMENT_TARGET_HP_STATUS" "Failed"/.test(block),
            'endpoint poll must NOT mark the deploy Failed');
        assert.ok(!/\bexit 1\b/.test(block),
            'endpoint poll must NOT exit on a missing/non-InService endpoint (advisory only)');
        // The endpoint state must be recorded as a SEPARATE sub-status.
        assert.ok(/HP_SAGEMAKER_ENDPOINT_STATUS/.test(block),
            'endpoint state must be recorded in HP_SAGEMAKER_ENDPOINT_STATUS (not the deploy status)');
    });

    it('writes Running after DeploymentComplete regardless of the endpoint', () => {
        // Gate 1 (CRD DeploymentComplete) is the hard requirement; it exits non-zero before
        // the Running write if not met. The Running write itself must not be conditional on
        // the endpoint status.
        assert.ok(/did not reach DeploymentComplete[\s\S]*?exit 1/.test(source),
            'gate 1 (CRD DeploymentComplete) must remain a hard requirement');
        const runIdx = source.indexOf('DEPLOYMENT_TARGET_HP_STATUS" "Running"');
        const epFailIdx = source.lastIndexOf('SageMaker endpoint', runIdx);
        // There must be no "exit 1" between the endpoint poll and the Running write.
        const between = source.slice(epFailIdx, runIdx);
        assert.ok(!/\bexit 1\b/.test(between),
            'no fatal exit may sit between the endpoint poll and the Running write');
    });
});

// BL143 live-rehearsal finding: the hyperpod-eks deploy driver must fail fast if the
// cluster inference capability as a NON-BLOCKING health check (BL143 open Q1).
// NOTE (owner decision, v2.0.0 planning): this is deliberately WARN-not-block. The
// InferenceConfig signal is under question — the operator has logged the inference
// watcher "Enabled" while describe-cluster still returns InferenceConfig: null — so a
// hard gate here would false-fail a working deploy. The driver must probe and warn,
// but MUST NOT exit on a null/absent InferenceConfig. (If the parked GPU model-deploy
// observation confirms InferenceConfig is the wrong signal, re-gate on operator
// watcher-status / SageMakerEndpointRegistration state and revisit this test.)
describe('hyperpod-eks deploy driver — cluster-inference preflight (non-blocking)', () => {
    const DRIVER = resolve(BOOTSTRAP, '../../templates/do/deploy.d/hyperpod-eks');
    const source = readFileSync(DRIVER, 'utf8');

    it('probes InferenceConfig as a health signal', () => {
        assert.ok(source.includes('InferenceConfig'), 'driver must probe InferenceConfig');
        assert.ok(
            source.includes('describe-cluster'),
            'driver must probe via sagemaker describe-cluster'
        );
    });

    it('warns but does NOT block the deploy on a null/absent InferenceConfig', () => {
        // Isolate the preflight block (between its header and the next step: rendering
        // the InferenceEndpointConfig). The block must warn, not exit.
        const start = source.indexOf('Preflight: cluster inference capability');
        assert.ok(start > -1, 'preflight block must be present');
        const end = source.indexOf('InferenceEndpointConfig custom resource', start);
        const block = source.slice(start, end > -1 ? end : start + 2500);
        assert.ok(/InferenceConfig: null/.test(block),
            'preflight must call out the InferenceConfig: null case');
        assert.ok(!/exit\s+\d/.test(block),
            'preflight must NOT exit on the inference-capability check (warn, not block)');
        assert.ok(!/_update_config "DEPLOYMENT_TARGET_HP_STATUS" "Failed"/.test(block),
            'preflight must NOT mark the deploy Failed on the inference-capability check');
        // A failed describe probe must be treated as "unknown", not "not enabled".
        assert.ok(/probe failed|_IC_PROBE_RC/.test(block),
            'a failed describe-cluster probe must be distinguished from a genuine null');
    });
});
