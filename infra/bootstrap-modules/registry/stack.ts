// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { Construct } from 'constructs';

export interface MlccRegistryStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * Registry module: Model Package Group (the SageMaker Model Registry group that
 * the MLflow→MPG bridge registers model versions into).
 *
 * BL123 RETIRED the branded `mlcc-registry-<account>` AI Registry Hub this module
 * used to provision (via a createHub custom resource). The BL122 spike proved the
 * high-level ai_registry SDK computes its own hub (`AiRegistry-<region>-<account>`)
 * and cannot be pointed at a named hub — so a branded hub was dead weight.
 * Datasets/evaluators now use the SDK's native hub (discoverable in Studio via the
 * `domain_id` tag); models live here in the Model Registry (never hub-mirrored).
 * (Supersedes the hotfix-ai-registry-hub spec.)
 */
export class MlccRegistryStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccRegistryStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'registry');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Model Package Group — the Model Registry group for MLflow→MPG model versions.
        const mpg = new sagemaker.CfnModelPackageGroup(this, 'ModelPackageGroup', {
            modelPackageGroupName: `mlcc-${profileName}-models`,
            modelPackageGroupDescription: `Model packages for ml-container-creator profile: ${profileName}`,
        });

        // Outputs
        new cdk.CfnOutput(this, 'ModelPackageGroupName', {
            value: mpg.modelPackageGroupName!,
            exportName: `mlcc-${profileName}-registry-ModelPackageGroupName`,
        });
    }
}
