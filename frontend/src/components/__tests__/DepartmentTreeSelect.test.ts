import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DepartmentTreeSelect from '@/components/DepartmentTreeSelect.vue'

const stubs = {
  Popover: { template: '<div><slot /></div>' },
  PopoverTrigger: { template: '<div><slot /></div>', props: ['asChild'] },
  PopoverContent: { template: '<div><slot /></div>' },
  Command: { template: '<div><slot /></div>' },
  CommandInput: { template: '<input />', props: ['placeholder'] },
  CommandEmpty: { template: '<div><slot /></div>' },
  CommandList: { template: '<div><slot /></div>' },
  CommandGroup: { template: '<div><slot /></div>', props: ['heading'] },
  CommandItem: {
    template: '<div @click="$emit(\'select\')"><slot /></div>',
    props: ['value'],
    emits: ['select'],
  },
}

const mockDepts = [
  {
    id: 'dept-1',
    name: '计算机学院',
    children: [
      { id: 'dept-1-1', name: '计算机科学与技术系' },
      { id: 'dept-1-2', name: '软件工程系' },
    ],
  },
  { id: 'dept-2', name: '数学学院' },
]

function mountComponent(props = {}) {
  return mount(DepartmentTreeSelect, {
    props: {
      departments: mockDepts,
      modelValue: '',
      ...props,
    },
    global: {
      stubs,
    },
  })
}

describe('DepartmentTreeSelect', () => {
  it('shows placeholder text when no selection', () => {
    const wrapper = mountComponent()

    expect(wrapper.text()).toContain('请选择学院')
  })

  it('shows selected department name when modelValue matches a child', () => {
    const wrapper = mountComponent({ modelValue: 'dept-1-1' })

    expect(wrapper.text()).toContain('计算机科学与技术系')
    expect(wrapper.text()).not.toContain('请选择学院')
  })

  it('shows selected department name when modelValue matches a standalone department', () => {
    const wrapper = mountComponent({ modelValue: 'dept-2' })

    expect(wrapper.text()).toContain('数学学院')
    expect(wrapper.text()).not.toContain('请选择学院')
  })

  it('renders child department items', () => {
    const wrapper = mountComponent()

    expect(wrapper.text()).toContain('计算机科学与技术系')
    expect(wrapper.text()).toContain('软件工程系')
    expect(wrapper.text()).toContain('数学学院')
  })

  it('emits update:modelValue when a department item is selected', async () => {
    const wrapper = mountComponent()

    // Find the CommandItem for '数学学院' (standalone dept)
    const items = wrapper.findAllComponents(stubs.CommandItem)
    const mathItem = items.find((item) => item.text().includes('数学学院'))!
    expect(mathItem).toBeTruthy()

    await mathItem.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['dept-2'])
  })
})
