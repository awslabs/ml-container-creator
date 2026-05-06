// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * KEY=VALUE Parser Unit Tests
 *
 * Tests basic splitting, edge cases, and error handling.
 * Requirements: 3.4, 3.5, 4.4, 4.5
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { parseKeyValue } from '../../generators/app/lib/key-value-parser.js';
import { ValidationError } from '../../generators/app/lib/config-manager.js';

describe('parseKeyValue', () => {
    describe('basic KEY=VALUE splitting', () => {
        it('should split a simple KEY=VALUE pair', () => {
            const result = parseKeyValue('TENSOR_PARALLEL_SIZE=4');
            assert.deepStrictEqual(result, { key: 'TENSOR_PARALLEL_SIZE', value: '4' });
        });

        it('should handle string values', () => {
            const result = parseKeyValue('HF_MODEL_ID=meta-llama/Llama-2-7b-chat-hf');
            assert.deepStrictEqual(result, { key: 'HF_MODEL_ID', value: 'meta-llama/Llama-2-7b-chat-hf' });
        });
    });

    describe('value containing multiple = characters', () => {
        it('should split only on the first = character', () => {
            const result = parseKeyValue('KEY=val=ue');
            assert.deepStrictEqual(result, { key: 'KEY', value: 'val=ue' });
        });

        it('should handle multiple = in value portion', () => {
            const result = parseKeyValue('CONFIG=a=b=c=d');
            assert.deepStrictEqual(result, { key: 'CONFIG', value: 'a=b=c=d' });
        });
    });

    describe('empty value (KEY=)', () => {
        it('should return empty string as value when nothing follows =', () => {
            const result = parseKeyValue('KEY=');
            assert.deepStrictEqual(result, { key: 'KEY', value: '' });
        });
    });

    describe('empty key (=VALUE)', () => {
        it('should return empty string as key when = is first character', () => {
            const result = parseKeyValue('=VALUE');
            assert.deepStrictEqual(result, { key: '', value: 'VALUE' });
        });
    });

    describe('missing = throws ValidationError', () => {
        it('should throw ValidationError when no = is present', () => {
            assert.throws(
                () => parseKeyValue('NO_EQUALS_HERE'),
                (error) => {
                    assert.ok(error instanceof ValidationError);
                    assert.ok(error.message.includes('Invalid format for env var'));
                    assert.ok(error.message.includes('expected KEY=VALUE'));
                    assert.ok(error.message.includes('NO_EQUALS_HERE'));
                    return true;
                }
            );
        });

        it('should throw ValidationError for empty string', () => {
            assert.throws(
                () => parseKeyValue(''),
                (error) => {
                    assert.ok(error instanceof ValidationError);
                    assert.ok(error.message.includes('expected KEY=VALUE'));
                    return true;
                }
            );
        });

        it('should include the input in the error message', () => {
            try {
                parseKeyValue('SOME_INVALID_INPUT');
                assert.fail('Should have thrown');
            } catch (error) {
                assert.ok(error.message.includes('SOME_INVALID_INPUT'));
            }
        });
    });
});
