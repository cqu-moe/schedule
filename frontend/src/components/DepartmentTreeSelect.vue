<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        class="w-full justify-between font-normal"
      >
        <span class="truncate">{{ selectedLabel || '请选择学院' }}</span>
        <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-[--reka-popover-trigger-width] p-0" align="start">
      <Command v-model="selected">
        <CommandInput placeholder="搜索学院..." />
        <CommandEmpty>未找到匹配的学院</CommandEmpty>
        <CommandList class="max-h-60">
          <template v-for="dept in departments" :key="dept.id">
            <!-- Department with children: render as group -->
            <CommandGroup v-if="dept.children" :heading="dept.name">
              <template v-for="child in dept.children" :key="child.id">
                <CommandItem
                  :value="child.id"
                  @select="selectDept(child)"
                >
                  <Check class="mr-2 h-4 w-4 shrink-0" :class="modelValue === child.id ? 'opacity-100' : 'opacity-0'" />
                  {{ child.name }}
                </CommandItem>
                <!-- 3rd-level children (e.g. 工程培训中心 under 机械与运载工程学院) -->
                <CommandItem
                  v-for="grandchild in (child.children || [])"
                  :key="grandchild.id"
                  :value="grandchild.id"
                  class="pl-6"
                  @select="selectDept(grandchild)"
                >
                  <Check class="mr-2 h-4 w-4 shrink-0" :class="modelValue === grandchild.id ? 'opacity-100' : 'opacity-0'" />
                  {{ grandchild.name }}
                </CommandItem>
              </template>
            </CommandGroup>
            <!-- Standalone department (no children): render as item -->
            <CommandItem
              v-else
              :value="dept.id"
              @select="selectDept(dept)"
            >
              <Check class="mr-2 h-4 w-4 shrink-0" :class="modelValue === dept.id ? 'opacity-100' : 'opacity-0'" />
              {{ dept.name }}
            </CommandItem>
          </template>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Check, ChevronsUpDown } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'

const props = defineProps({
  departments: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const selected = ref('')

// Build flat lookup for label display
const allDepts = computed(() => {
  const result = []
  function walk(list) {
    for (const d of list) {
      result.push(d)
      if (d.children) walk(d.children)
    }
  }
  walk(props.departments)
  return result
})

const selectedLabel = computed(() =>
  allDepts.value.find(d => d.id === props.modelValue)?.name || ''
)

function selectDept(dept) {
  emit('update:modelValue', dept.id)
  open.value = false
}
</script>
