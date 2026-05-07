// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { select, input, confirm, checkbox, number, Separator } from '@inquirer/prompts';

/**
 * Maps Yeoman prompt type names to @inquirer/prompts runner functions.
 */
const runners = { list: select, select, input, confirm, checkbox, number };

/**
 * Runs a sequence of Yeoman-style prompt definitions using @inquirer/prompts.
 *
 * Handles:
 * - Type mapping (list → select)
 * - Conditional prompts via `when` function
 * - Dynamic `choices`, `default`, and `message` (functions resolved with current answers)
 * - Separator mapping from Yeoman format to @inquirer/prompts Separator
 * - Validate function passthrough
 *
 * @param {Array<object>} prompts - Array of Yeoman-style prompt definitions
 * @param {object} [previousAnswers={}] - Answers from prior prompt phases
 * @param {object} [options={}] - Options for dependency injection
 * @param {object} [options.runners] - Override prompt runners (useful for testing)
 * @returns {Promise<object>} Accumulated answers keyed by prompt name
 */
export async function runPrompts(prompts, previousAnswers = {}, options = {}) {
    const promptRunners = options.runners || runners;
    const answers = { ...previousAnswers };

    for (const prompt of prompts) {
        if (prompt.when && !prompt.when(answers)) continue;

        const type = prompt.type === 'list' ? 'select' : prompt.type;
        const runner = promptRunners[type];

        if (!runner) {
            throw new Error(`Unsupported prompt type: "${prompt.type}"`);
        }

        const message = typeof prompt.message === 'function'
            ? prompt.message(answers) : prompt.message;
        const choices = typeof prompt.choices === 'function'
            ? prompt.choices(answers) : prompt.choices;
        const defaultVal = typeof prompt.default === 'function'
            ? prompt.default(answers) : prompt.default;

        const mappedChoices = choices?.map(c =>
            c && c.type === 'separator'
                ? new Separator(c.separator || c.line)
                : c
        );

        const config = { message };
        if (mappedChoices !== undefined) config.choices = mappedChoices;
        if (defaultVal !== undefined) config.default = defaultVal;
        if (prompt.validate) config.validate = prompt.validate;

        answers[prompt.name] = await runner(config);
    }

    return answers;
}
