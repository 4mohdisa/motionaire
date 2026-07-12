import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import { isTauri } from '../compositor/bridge'

// Boot: resolve activation + first-run state once at startup.
export function useBootFlow() {
  useEffect(() => {
    void (async () => {
      const st = useStore.getState()
      if (st.appView !== 'boot') return
      if (!isTauri) {
        st.setAppView('editor') // browser dev: no gate to talk to
        return
      }
      const activated = await invoke<boolean>('license_status').catch(() => false)
      if (!activated) {
        st.setAppView('activate')
        return
      }
      const done = await invoke<string | null>('get_setting', {
        key: 'onboarding_completed',
      }).catch(() => null)
      // Don't clobber a view a self-test already forced (e.g. loadPipDemo).
      if (useStore.getState().appView === 'boot')
        useStore.getState().setAppView(done === '1' ? 'launcher' : 'onboard')
    })()
  }, [])
}
