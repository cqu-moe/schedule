import { ref } from 'vue'

export function useRiskWarning() {
  const showRiskWarning = ref(
    !localStorage.getItem('risk_warning_acknowledged')
  )
  return { showRiskWarning }
}
