// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Module Interface.
 *
 * Each module implements provision/teardown/status for independent lifecycle management.
 */

export type ModuleState = 'provisioned' | 'not-provisioned' | 'failed' | 'updating';

export interface ModuleStatus {
    state: ModuleState;
    stackName?: string;
    resources: string[];
    lastUpdated?: string;
}

export interface ModuleProfile {
    accountId: string;
    awsRegion: string;
    awsProfile?: string;
    profileName: string;
    provisionedModules?: string[];
    moduleOutputs?: Record<string, Record<string, string>>;
}

export interface BootstrapModule {
    /** Module name from manifest. */
    readonly name: string;

    /** Provision this module's infrastructure. Idempotent. */
    provision(profile: ModuleProfile): Promise<Record<string, string>>;

    /** Tear down this module's infrastructure. */
    teardown(profile: ModuleProfile): Promise<void>;

    /** Check the current status of this module's stack. */
    status(profile: ModuleProfile): Promise<ModuleStatus>;
}
