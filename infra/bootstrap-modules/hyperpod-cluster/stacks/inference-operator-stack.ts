// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface MlccInferenceOperatorStackProps extends cdk.StackProps {
    profileName: string;
    adoptTlsBucket?: boolean;
    adoptInferenceAddon?: boolean;
    // Consumed from Stack 1 + Stack 2 SSM params (passed as CDK context)
    eksClusterName?: string;
    hyperPodClusterArn?: string;
    hyperpodInferenceRoleArn?: string;
    albControllerRoleArn?: string;
    kedaOperatorRoleArn?: string;
}

/**
 * Stack 3 of the HyperPod module: Installs the SageMaker HyperPod Inference
 * Operator as an EKS add-on, plus the TLS S3 bucket it requires.
 *
 * Inputs: All values come from Stack 1 + Stack 2 SSM params, passed as
 * CDK context by the multi-stack module runner.
 */
export class MlccInferenceOperatorStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccInferenceOperatorStackProps) {
        super(scope, id, props);

        const { profileName } = props;
        const region = this.region;
        const ssmPrefix = `/mlcc/${profileName}/hyperpod`;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod-cluster');
        cdk.Tags.of(this).add('mlcc:profile', profileName);
        cdk.Tags.of(this).add('mlcc:stack', 'inference-operator');

        // Read inputs from context (injected by module runner from SSM)
        const eksClusterName = props.eksClusterName
            || this.node.tryGetContext('EksClusterName')
            || '';
        const hyperPodClusterArn = props.hyperPodClusterArn
            || this.node.tryGetContext('HyperPodClusterArn')
            || '';
        const hyperpodInferenceRoleArn = props.hyperpodInferenceRoleArn
            || this.node.tryGetContext('HyperpodInferenceRoleArn')
            || '';
        const albControllerRoleArn = props.albControllerRoleArn
            || this.node.tryGetContext('AlbControllerRoleArn')
            || '';
        const kedaOperatorRoleArn = props.kedaOperatorRoleArn
            || this.node.tryGetContext('KedaOperatorRoleArn')
            || '';

        // Validate required inputs — during destroy, context may be empty.
        // Return early (empty stack) so CDK can still find and destroy it.
        if (!hyperPodClusterArn) {
            return;
        }

        // ─── TLS S3 Bucket (RemovalPolicy.RETAIN) ───────────────────────────

        const bucketName = `mlcc-hyperpod-tls-${profileName}`;
        let tlsBucket: s3.IBucket;

        if (props.adoptTlsBucket) {
            tlsBucket = s3.Bucket.fromBucketName(this, 'TlsBucket', bucketName);
        } else {
            const newBucket = new s3.Bucket(this, 'TlsBucket', {
                bucketName,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                autoDeleteObjects: false,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            });
            tlsBucket = newBucket;
        }

        // ─── Inference Operator EKS Add-on ──────────────────────────────────

        if (!props.adoptInferenceAddon) {
            const configValues = JSON.stringify({
                executionRoleArn: hyperpodInferenceRoleArn,
                tlsCertificateS3Bucket: bucketName,
                hyperpodClusterArn: hyperPodClusterArn,
                alb: {
                    serviceAccount: {
                        create: true,
                        roleArn: albControllerRoleArn,
                    },
                },
                keda: {
                    auth: {
                        aws: {
                            irsa: {
                                roleArn: kedaOperatorRoleArn,
                            },
                        },
                    },
                },
            });

            const addon = new eks.CfnAddon(this, 'InferenceOperatorAddon', {
                clusterName: eksClusterName,
                addonName: 'amazon-sagemaker-hyperpod-inference',
                configurationValues: configValues,
                resolveConflicts: 'OVERWRITE',
            });

            addon.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
        }

        // ─── SSM Exports ────────────────────────────────────────────────────

        new ssm.StringParameter(this, 'InferenceOperatorStatusParam', {
            parameterName: `${ssmPrefix}/InferenceOperatorStatus`,
            stringValue: 'active',
            description: 'Inference Operator installation status',
        });

        // ─── CfnOutputs ────────────────────────────────────────────────────

        new cdk.CfnOutput(this, 'InferenceOperatorStatusOutput', {
            value: 'active',
            exportName: `mlcc-${profileName}-inference-InferenceOperatorStatus`,
        });

        new cdk.CfnOutput(this, 'TlsBucketNameOutput', {
            value: bucketName,
            exportName: `mlcc-${profileName}-inference-TlsBucketName`,
        });
    }
}
