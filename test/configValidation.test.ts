import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateUserConfig } from '../src/lib/utils/configValidation.js'

test('accepts an empty user config', () => {
  assert.doesNotThrow(() => validateUserConfig({}, 'config.yaml'))
})

test('accepts a config containing recognized JulesBot keys', () => {
  assert.doesNotThrow(() =>
    validateUserConfig(
      {
        access_control: { allow_all: true },
        guilds: {},
      },
      'config.yaml',
    ),
  )
})

test('rejects a non-mapping YAML root', () => {
  assert.throws(
    () => validateUserConfig(['not', 'a', 'mapping'], 'config.yaml'),
    /must contain a YAML mapping/,
  )
})

test('rejects an unrelated LiteLLM config', () => {
  assert.throws(
    () =>
      validateUserConfig(
        {
          model_list: [],
          litellm_settings: { max_retries: 0 },
        },
        'config.yaml',
      ),
    /configuration for another application/,
  )
})

test('rejects configs with no recognized JulesBot settings', () => {
  assert.throws(
    () => validateUserConfig({ unrelated_setting: true }, 'config.yaml'),
    /does not contain any recognized JulesBot settings/,
  )
})
