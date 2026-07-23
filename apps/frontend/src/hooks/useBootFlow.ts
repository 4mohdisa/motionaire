import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import { refreshAiConfigured } from '../persistence/aiSettings'
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
      // App prefs (foundation, Phase 7) load once at boot.
      // AI configured = a key exists for the chosen chat provider (or mock,
      // which needs none). Checked at boot and after settings changes.
      void refreshAiConfigured().then(async () => {
        // First-run AI onboarding (Run 1, Phase 7): nothing AI works without
        // a key — say so ONCE, with a direct path to the setting.
        const st2 = useStore.getState()
        if (st2.aiConfigured) return
        const seen = await invoke<string | null>('get_setting', { key: 'aiOnboardShown' }).catch(
          () => '1',
        )
        if (seen) return
        void invoke('set_setting', { key: 'aiOnboardShown', value: '1' }).catch(() => {})
        st2.pushToast(
          'info',
          'AI editing is ready to set up — add an API key (or pick the offline mock) to edit with plain English.',
          undefined,
          {
            label: 'Open AI settings',
            onClick: () => useStore.getState().setDialog('preferences'),
          },
        )
      })
      void invoke<string | null>('get_setting', { key: 'prefs' })
        .then((raw) => {
          if (raw)
            st.setPrefs(JSON.parse(raw) as Partial<{ autosaveSecs: number; autoProxy: boolean }>)
        })
        .catch(() => {})
      // Release decision: the open-source build ships UNLOCKED — no license
      // gate at boot. The LicenseValidator seam (license.rs + the activate/
      // deactivate commands + the gate view) stays intact for any future
      // commercial build; only this check was removed.
      const done = await invoke<string | null>('get_setting', {
        key: 'onboarding_completed',
      }).catch(() => null)
      // Don't clobber a view a self-test already forced (e.g. loadPipDemo).
      if (useStore.getState().appView === 'boot')
        useStore.getState().setAppView(done === '1' ? 'launcher' : 'onboard')
    })()
  }, [])
}
