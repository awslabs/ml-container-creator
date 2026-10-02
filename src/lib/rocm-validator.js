import SemverAcceleratorValidator from './semver-accelerator-validator.js';

/*
 * PATTERN: Strategy — the ROCm (AMD GPU) specialisation of the shared semver
 *   accelerator validator.
 * COLLABORATORS: extends SemverAcceleratorValidator (which holds the
 *   major-match/minor->= algorithm); registered as the 'rocm' validator by
 *   ValidationEngine.
 * DATA-FLOW ROLE: supplies only ROCm's label and its AMD GPU guidance; the
 *   version comparison is inherited, so neuron and rocm no longer duplicate it.
 * See: docs/architecture/validation.md, docs/adr/ADR-006-unified-validation-framework.md
 *
 * Requirements: 4.9, 4.22
 */
export default class RocmValidator extends SemverAcceleratorValidator {
    constructor() {
        super({
            label: 'ROCm',
            mismatchTail: 'AMD GPU instances with ROCm support may be limited in SageMaker.'
        });
    }
}
