import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { useEditableFields } from '../app/composables/useEditableFields'

let scope: EffectScope | undefined
afterEach(() => scope?.stop())
function fixture() {
  const data = ref({ id: 'first', label: 'Original', enabled: true, maxConcurrency: 2 })
  scope = effectScope()
  const fields = scope.run(() => useEditableFields(() => {
    const { id: _id, ...value } = data.value
    return value
  }, () => data.value.id))!
  return { data, ...fields }
}
describe('edit forms receiving refreshed data', () => {
  it('updates pristine fields when another tab changes the account', async () => {
    const { data, form, dirty } = fixture()
    data.value = { ...data.value, enabled: false, maxConcurrency: 4 }
    await nextTick()
    expect(form.value).toEqual({ label: 'Original', enabled: false, maxConcurrency: 4 })
    expect(dirty.value).toBe(false)
  })
  it('keeps unsaved edits while merging independent server changes', async () => {
    const { data, form, dirty } = fixture()
    form.value!.label = 'Local edit'
    data.value = { ...data.value, label: 'Remote edit', enabled: false }
    await nextTick()
    expect(form.value).toEqual({ label: 'Local edit', enabled: false, maxConcurrency: 2 })
    expect(dirty.value).toBe(true)
    data.value = { ...data.value, maxConcurrency: 6 }
    await nextTick()
    expect(form.value!.label).toBe('Local edit')
    expect(form.value!.maxConcurrency).toBe(6)
  })
  it('resets to the latest server data instead of the original snapshot', async () => {
    const { data, form, dirty, reset } = fixture()
    form.value!.label = 'Local edit'
    data.value = { ...data.value, label: 'Remote edit' }
    await nextTick()
    reset()
    expect(form.value!.label).toBe('Remote edit')
    expect(dirty.value).toBe(false)
  })
  it('does not carry unsaved edits into a different account', async () => {
    const { data, form, dirty } = fixture()
    form.value!.label = 'Local edit'
    data.value = { id: 'second', label: 'Second account', enabled: false, maxConcurrency: 8 }
    await nextTick()
    expect(form.value).toEqual({ label: 'Second account', enabled: false, maxConcurrency: 8 })
    expect(dirty.value).toBe(false)
  })
  it('accepts normalized save results as the new clean baseline', async () => {
    const { form, dirty, reset } = fixture()
    form.value!.label = '  Local edit  '
    reset({ label: 'Local edit', enabled: true, maxConcurrency: 2 })
    expect(form.value!.label).toBe('Local edit')
    expect(dirty.value).toBe(false)
  })
})
