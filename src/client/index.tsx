import { TYPERT_REMOTE } from '../typert/remote.js'
import { NS, PANEL_ID, locales } from './locales.js'
import { store } from './singleton.js'
import { CSS } from './styles.js'
import { UpdateIcon, UpdatePanel } from './UpdatePanel.js'

/** Cordis services the bundle needs before it can mount the Remote namespace. */
export const inject = ['remote', 'slots', 'locale']

/**
 * The panel is a keyed `main` slot and the sidebar entry is a
 * `sidebar.panellist` list item. The Remote contribution is mounted first, then
 * UI registration waits for `remote.dshUpdate` to be installed by the gateway.
 */
export async function apply(ctx: any): Promise<void> {
  const style = document.createElement('style')
  style.textContent = CSS
  style.dataset.plugin = '@tiantao-code/dsh-update'
  document.head.append(style)
  ctx.effect(() => () => style.remove(), 'dsh-update: styles')

  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => () => void unmountRemote(), 'dsh-update: remote')

  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-update: locale')
  const t = ctx.locale.bind(NS)

  ctx.inject(['remote.dshUpdate', 'slots', 'locale'], (child: any) => {
    const disposeMain = child.slots.inject('main', function* () {
      yield child.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ store }),
        },
        UpdatePanel,
      )
    })
    const disposeSidebar = child.slots.inject('sidebar.panellist', () =>
      child.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 0,
          label: () => t('panel'),
          locale: NS,
        },
        UpdateIcon,
      ),
    )
    child.effect(() => {
      store.connect(child, child.remote.dshUpdate)
      return () => store.dispose()
    }, 'dsh-update: panel store')
    child.effect(() => () => {
      if (typeof disposeMain === 'function') disposeMain()
      if (typeof disposeSidebar === 'function') disposeSidebar()
    }, 'dsh-update: slots')
  })
}
