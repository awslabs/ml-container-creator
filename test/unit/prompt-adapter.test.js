// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'mocha';
import assert from 'assert';
import { Separator } from '@inquirer/prompts';
import { runPrompts } from '../../src/prompt-adapter.js';

/**
 * Creates a mock runner that returns a predetermined value.
 */
function mockRunner(returnValue) {
    const calls = [];
    const fn = async (config) => {
        calls.push(config);
        return returnValue;
    };
    fn.calls = calls;
    return fn;
}

describe('prompt-adapter', () => {
    describe('type mapping', () => {
        it('should map "list" type to "select" runner', async () => {
            const selectRunner = mockRunner('picked');
            const runners = { select: selectRunner, input: mockRunner('') };

            const prompts = [
                { type: 'list', name: 'choice', message: 'Pick one:', choices: [{ name: 'A', value: 'a' }] }
            ];

            const answers = await runPrompts(prompts, {}, { runners });

            assert.strictEqual(answers.choice, 'picked');
            assert.strictEqual(selectRunner.calls.length, 1);
        });

        it('should use "input" runner for input type', async () => {
            const inputRunner = mockRunner('typed-value');
            const runners = { input: inputRunner };

            const prompts = [
                { type: 'input', name: 'name', message: 'Your name?' }
            ];

            const answers = await runPrompts(prompts, {}, { runners });

            assert.strictEqual(answers.name, 'typed-value');
            assert.strictEqual(inputRunner.calls.length, 1);
        });

        it('should use "confirm" runner for confirm type', async () => {
            const confirmRunner = mockRunner(true);
            const runners = { confirm: confirmRunner };

            const prompts = [
                { type: 'confirm', name: 'proceed', message: 'Continue?' }
            ];

            const answers = await runPrompts(prompts, {}, { runners });

            assert.strictEqual(answers.proceed, true);
        });

        it('should throw for unsupported prompt type', async () => {
            const runners = {};
            const prompts = [
                { type: 'unknown', name: 'x', message: 'What?' }
            ];

            await assert.rejects(
                () => runPrompts(prompts, {}, { runners }),
                (err) => {
                    assert.ok(err.message.includes('Unsupported prompt type'));
                    return true;
                }
            );
        });
    });

    describe('conditional prompt skipping via when', () => {
        it('should skip prompt when "when" returns false', async () => {
            const inputRunner = mockRunner('value');
            const runners = { input: inputRunner };

            const prompts = [
                { type: 'input', name: 'skipped', message: 'Skip me', when: () => false },
                { type: 'input', name: 'shown', message: 'Show me', when: () => true }
            ];

            const answers = await runPrompts(prompts, {}, { runners });

            assert.strictEqual(answers.skipped, undefined);
            assert.strictEqual(answers.shown, 'value');
            assert.strictEqual(inputRunner.calls.length, 1);
        });

        it('should pass current answers to "when" function', async () => {
            const inputRunner = mockRunner('second-val');
            const selectRunner = mockRunner('first-val');
            const runners = { select: selectRunner, input: inputRunner };

            let whenReceivedAnswers = null;
            const prompts = [
                { type: 'list', name: 'first', message: 'First?', choices: [{ name: 'A', value: 'first-val' }] },
                {
                    type: 'input', name: 'second', message: 'Second?',
                    when: (answers) => { whenReceivedAnswers = { ...answers }; return true; }
                }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.strictEqual(whenReceivedAnswers.first, 'first-val');
        });

        it('should include previousAnswers in when evaluation', async () => {
            const inputRunner = mockRunner('val');
            const runners = { input: inputRunner };

            let whenReceivedAnswers = null;
            const prompts = [
                {
                    type: 'input', name: 'field', message: 'Field?',
                    when: (answers) => { whenReceivedAnswers = { ...answers }; return true; }
                }
            ];

            await runPrompts(prompts, { existing: 'prev' }, { runners });

            assert.strictEqual(whenReceivedAnswers.existing, 'prev');
        });
    });

    describe('dynamic choices resolution', () => {
        it('should resolve choices function with current answers', async () => {
            const selectRunner = mockRunner('dynamic-choice');
            const runners = { select: selectRunner };

            const prompts = [
                {
                    type: 'list', name: 'item', message: 'Pick:',
                    choices: (answers) => [
                        { name: `Option for ${answers.context}`, value: 'dynamic-choice' }
                    ]
                }
            ];

            const answers = await runPrompts(prompts, { context: 'test' }, { runners });

            assert.strictEqual(answers.item, 'dynamic-choice');
            assert.strictEqual(selectRunner.calls[0].choices[0].name, 'Option for test');
        });

        it('should pass static choices array directly', async () => {
            const selectRunner = mockRunner('a');
            const runners = { select: selectRunner };

            const staticChoices = [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }];
            const prompts = [
                { type: 'list', name: 'pick', message: 'Pick:', choices: staticChoices }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.deepStrictEqual(selectRunner.calls[0].choices, staticChoices);
        });
    });

    describe('separator mapping', () => {
        it('should map Yeoman separator objects to Separator instances', async () => {
            const selectRunner = mockRunner('val');
            const runners = { select: selectRunner };

            const prompts = [
                {
                    type: 'list', name: 'item', message: 'Pick:',
                    choices: [
                        { type: 'separator', separator: '── Models ──' },
                        { name: 'Model A', value: 'val' }
                    ]
                }
            ];

            await runPrompts(prompts, {}, { runners });

            const passedChoices = selectRunner.calls[0].choices;
            assert.ok(passedChoices[0] instanceof Separator);
            assert.strictEqual(passedChoices[1].name, 'Model A');
        });

        it('should handle separator with "line" property', async () => {
            const selectRunner = mockRunner('val');
            const runners = { select: selectRunner };

            const prompts = [
                {
                    type: 'list', name: 'item', message: 'Pick:',
                    choices: [
                        { type: 'separator', line: '── Section ──' },
                        { name: 'Item', value: 'val' }
                    ]
                }
            ];

            await runPrompts(prompts, {}, { runners });

            const passedChoices = selectRunner.calls[0].choices;
            assert.ok(passedChoices[0] instanceof Separator);
        });
    });

    describe('answer accumulation', () => {
        it('should accumulate answers across prompts', async () => {
            let callCount = 0;
            const runners = {
                input: async () => `answer-${++callCount}`,
                select: async () => 'selected'
            };

            const prompts = [
                { type: 'input', name: 'first', message: 'First?' },
                { type: 'input', name: 'second', message: 'Second?' },
                { type: 'list', name: 'third', message: 'Third?', choices: [{ name: 'X', value: 'selected' }] }
            ];

            const answers = await runPrompts(prompts, {}, { runners });

            assert.strictEqual(answers.first, 'answer-1');
            assert.strictEqual(answers.second, 'answer-2');
            assert.strictEqual(answers.third, 'selected');
        });

        it('should merge with previousAnswers', async () => {
            const runners = { input: async () => 'new-val' };

            const prompts = [
                { type: 'input', name: 'newField', message: 'New?' }
            ];

            const answers = await runPrompts(prompts, { existing: 'old-val' }, { runners });

            assert.strictEqual(answers.existing, 'old-val');
            assert.strictEqual(answers.newField, 'new-val');
        });
    });

    describe('validate passthrough', () => {
        it('should pass validate function to the runner', async () => {
            const inputRunner = mockRunner('valid-input');
            const runners = { input: inputRunner };

            const validateFn = (val) => val.length > 0 || 'Cannot be empty';
            const prompts = [
                { type: 'input', name: 'field', message: 'Enter:', validate: validateFn }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.strictEqual(inputRunner.calls[0].validate, validateFn);
        });

        it('should not include validate when not defined', async () => {
            const inputRunner = mockRunner('value');
            const runners = { input: inputRunner };

            const prompts = [
                { type: 'input', name: 'field', message: 'Enter:' }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.strictEqual(inputRunner.calls[0].validate, undefined);
        });
    });

    describe('dynamic default resolution', () => {
        it('should resolve default function with current answers', async () => {
            const inputRunner = mockRunner('user-input');
            const runners = { input: inputRunner };

            const prompts = [
                {
                    type: 'input', name: 'name', message: 'Name?',
                    default: (answers) => `${answers.prefix}-project`
                }
            ];

            await runPrompts(prompts, { prefix: 'my' }, { runners });

            assert.strictEqual(inputRunner.calls[0].default, 'my-project');
        });

        it('should pass static default value directly', async () => {
            const inputRunner = mockRunner('user-input');
            const runners = { input: inputRunner };

            const prompts = [
                { type: 'input', name: 'region', message: 'Region?', default: 'us-east-1' }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.strictEqual(inputRunner.calls[0].default, 'us-east-1');
        });

        it('should not include default when undefined', async () => {
            const inputRunner = mockRunner('value');
            const runners = { input: inputRunner };

            const prompts = [
                { type: 'input', name: 'field', message: 'Enter:' }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.ok(!('default' in inputRunner.calls[0]));
        });
    });

    describe('dynamic message resolution', () => {
        it('should resolve message function with current answers', async () => {
            const inputRunner = mockRunner('value');
            const runners = { input: inputRunner };

            const prompts = [
                {
                    type: 'input', name: 'field',
                    message: (answers) => `Configure ${answers.framework}:`
                }
            ];

            await runPrompts(prompts, { framework: 'sklearn' }, { runners });

            assert.strictEqual(inputRunner.calls[0].message, 'Configure sklearn:');
        });

        it('should pass static message string directly', async () => {
            const inputRunner = mockRunner('value');
            const runners = { input: inputRunner };

            const prompts = [
                { type: 'input', name: 'field', message: 'Static message:' }
            ];

            await runPrompts(prompts, {}, { runners });

            assert.strictEqual(inputRunner.calls[0].message, 'Static message:');
        });
    });
});
