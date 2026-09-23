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
const STACKS_DIR = resolve(__dirname, '../../infra/bootstrap-modules/hyperpod-cluster/stacks');

describe('HyperPod CDK Stack Files', () => {
    describe('Stack file existence', () => {
        it('eks-cluster-stack.ts exists', () => {
            assert.ok(existsSync(resolve(STACKS_DIR, 'eks-cluster-stack.ts')));
        });

        it('hyperpod-cluster-stack.ts exists', () => {
            assert.ok(existsSync(resolve(STACKS_DIR, 'hyperpod-cluster-stack.ts')));
        });

        it('inference-operator-stack.ts exists', () => {
            assert.ok(existsSync(resolve(STACKS_DIR, 'inference-operator-stack.ts')));
        });
    });

    describe('EKS Cluster Stack (source analysis)', () => {
        const source = readFileSync(resolve(STACKS_DIR, 'eks-cluster-stack.ts'), 'utf8');

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
                assert.ok(lifecyclePolicy.includes('arn:aws:s3:::mlcc-core-${this.account}-${this.region}'));
                assert.ok(lifecyclePolicy.includes('arn:aws:s3:::mlcc-core-${this.account}-${this.region}/*'));
            });

            it('grants HyperPod ENI management permissions', () => {
                const policyStart = hyperpodRoleSource.indexOf('sid: \'HyperPodEksInstancePolicy\'');
                const policyEnd = hyperpodRoleSource.indexOf('}));', policyStart);
                const eniPolicy = hyperpodRoleSource.slice(policyStart, policyEnd);

                assert.ok(eniPolicy.includes('\'ec2:CreateNetworkInterface\''));
                assert.ok(eniPolicy.includes('\'ec2:AttachNetworkInterface\''));
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

        it('applies RemovalPolicy.RETAIN on IAM roles', () => {
            assert.ok(source.includes('RemovalPolicy.RETAIN'));
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

        it('supports adopt-existing path via props', () => {
            assert.ok(source.includes('adoptEks'));
            assert.ok(source.includes('adoptVpc'));
            assert.ok(source.includes('adoptRoles'));
            assert.ok(source.includes('fromLookup'));
            assert.ok(source.includes('fromClusterAttributes'));
            assert.ok(source.includes('fromRoleName'));
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
        const source = readFileSync(resolve(STACKS_DIR, 'hyperpod-cluster-stack.ts'), 'utf8');

        it('creates CfnCluster (native CloudFormation resource)', () => {
            assert.ok(source.includes('CfnCluster'));
        });

        it('has instance group with instanceCount: 0', () => {
            assert.ok(source.includes('instanceCount: 0'));
        });

        it('uses default instance type ml.g5.2xlarge', () => {
            assert.ok(source.includes('ml.g5.2xlarge'));
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
        const source = readFileSync(resolve(STACKS_DIR, 'inference-operator-stack.ts'), 'utf8');

        it('creates TLS S3 bucket with correct naming', () => {
            assert.ok(source.includes('hyperpod-tls-'));
            assert.ok(source.includes('TlsBucket'));
        });

        it('applies RemovalPolicy.RETAIN on TLS bucket', () => {
            assert.ok(source.includes('RemovalPolicy.RETAIN'));
        });

        it('sets autoDeleteObjects: false on bucket', () => {
            assert.ok(source.includes('autoDeleteObjects: false'));
        });

        it('defers inference operator installation to the module runner', () => {
            assert.ok(source.includes('_installInferenceAddon()'));
            assert.doesNotMatch(source, /^\s*new eks\.CfnAddon\(/m);
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

        it('does not declare the inference add-on as a CloudFormation resource', () => {
            assert.doesNotMatch(source, /^\s*new eks\.CfnAddon\(/m);
        });

        it('exports InferenceOperatorStatus as SSM param', () => {
            assert.ok(source.includes('/InferenceOperatorStatus'));
        });

        it('supports adopt-existing TLS bucket', () => {
            assert.ok(source.includes('adoptTlsBucket'));
            assert.ok(source.includes('fromBucketName'));
        });

        it('supports adopt-existing inference addon', () => {
            assert.ok(source.includes('adoptInferenceAddon'));
        });

        it('returns an empty stack when HyperPodClusterArn is unavailable during destroy', () => {
            assert.match(source, /if \(!hyperPodClusterArn\) \{\s*return;\s*\}/);
        });
    });
});
