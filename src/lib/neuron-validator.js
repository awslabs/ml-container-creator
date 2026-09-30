import SemverAcceleratorValidator from './semver-accelerator-validator.js';

/*
 * PATTERN: Strategy — the Neuron SDK specialisation of the shared semver
 *   accelerator validator.
 * COLLABORATORS: extends SemverAcceleratorValidator (which holds the
 *   major-match/minor->= algorithm); registered as the 'neuron' validator by
 *   ValidationEngine.
 * DATA-FLOW ROLE: supplies only Neuron's label and its ml.inf2 guidance; the
 *   version comparison is inherited, so neuron and rocm no longer duplicate it.
 * See: docs/architecture/validation.md, docs/adr/ADR-006-unified-validation-framework.md
 *
 * Requirements: 4.11, 4.12, 4.13, 4.14, 4.22
 */
export default class NeuronValidator extends SemverAcceleratorValidator {
    constructor() {
        super({
            label: 'Neuron SDK',
            mismatchTail: 'Consider using ml.inf2 instances for Neuron SDK 2.15+ support.'
        });
    }
}
