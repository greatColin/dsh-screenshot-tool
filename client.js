/**
 * Client half of the screenshot tool.
 *
 * Adds one round control to the composer tool row, beside the add button. A
 * click asks the Host half for a fresh capture of every display, then opens a
 * chat-app-style region picker: the page enters OS fullscreen so the capture of
 * the display in front of the user is shown one-to-one with the real screen,
 * and the other displays are one Tab (or one pager click) away. Drag to pick
 * any area, Enter or the confirm button to accept, Esc, a right click, or the
 * cancel button to discard. A confirmed region becomes a PNG attachment in the
 * current message draft through the conversation's own draft pipeline, so the
 * composer's upload, preview, retry, and send behaviour stays in charge.
 */
window.__ModuleLoader__.load({
  id: '@local/screenshot-tool',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Host route, relative to the Web origin root. */
    const CAPTURE_ROUTE = 'screenshot-tool/capture'
    /** Locale namespace this plugin owns. */
    const NS = 'screenshotTool'
    /** Above the shell's frame-wide overlay and every host popup. */
    const OVERLAY_Z_INDEX = 2147483000
    /** A selection below this many CSS pixels is a click, not a region. */
    const MIN_SELECTION_PX = 2
    /** Component-local capture spinner; the element unmounts with the control. */
    const SPINNER_KEYFRAMES = '@keyframes dsh-screenshot-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
    /** Shared toolbar button geometry. */
    const TOOL_BUTTON = {
      height: '28px',
      padding: '0 12px',
      border: 'none',
      borderRadius: '999px',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '28px',
      flex: 'none',
    }

    const DICTIONARIES = {
      en: {
        button: 'Screenshot',
        hint: 'Drag to select a region · Enter to confirm · Esc to cancel',
        switchHint: 'Tab switches display',
        display: 'Display {index}',
        confirm: 'Add to message',
        cancel: 'Cancel',
        size: '{width} × {height}',
        failed: 'Screen capture failed: {reason}',
        insertFailed: 'Could not add the screenshot to the message',
        unavailable: 'Screenshots are unavailable in this session',
      },
      zh: {
        button: '截图',
        hint: '拖动选择任意区域 · Enter 确认 · Esc 取消',
        switchHint: 'Tab 切换显示器',
        display: '显示器 {index}',
        confirm: '添加到输入框',
        cancel: '取消',
        size: '{width} × {height}',
        failed: '截图失败：{reason}',
        insertFailed: '无法把截图添加到输入框',
        unavailable: '当前会话无法添加截图',
      },
    }

    //#region helpers

    /** Keep one coordinate inside a range. */
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /** Two drag corners to one top-left rectangle. */
    function normalizeSelection(start, end) {
      return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      }
    }

    /** Decode one data-URL capture; the element is also the crop source later. */
    function decodeImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => { resolve(image) }
        image.onerror = () => { reject(new Error('the captured image could not be decoded')) }
        image.src = url
      })
    }

    /** Read one response blob as a data URL, so picker state owns no object URL. */
    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => { resolve(String(reader.result)) }
        reader.onerror = () => { reject(new Error('the captured image could not be read')) }
        reader.readAsDataURL(blob)
      })
    }

    /** Whether this Session accepts staged image uploads (a subagent continuation does not). */
    function acceptsImageUploads(ctx, sessionId) {
      try {
        const sessions = ctx.get('sessions')
        if (sessions === undefined || sessions === null || typeof sessions.binding !== 'function') return true
        const binding = sessions.binding(sessionId)
        const session = binding === undefined || binding === null ? undefined : binding.session
        const snapshot = session === undefined || session === null || typeof session.getSnapshot !== 'function' ? undefined : session.getSnapshot()
        return snapshot === undefined || snapshot === null ? true : snapshot.subagent === null
      } catch {
        return true
      }
    }

    /** Append already-created draft attachment ids to the composer's current draft. */
    function addDraftAttachments(conversation, inputActions, sessionId, ids) {
      try {
        if (inputActions !== undefined && inputActions !== null && typeof inputActions.addAttachments === 'function') {
          return inputActions.addAttachments(ids) !== false
        }
        const input = conversation.input
        const shell = input === undefined || input === null || typeof input.shell !== 'function' ? undefined : input.shell(sessionId)
        if (shell !== undefined && shell !== null && typeof shell.addAttachments === 'function') {
          return shell.addAttachments(ids) !== false
        }
      } catch {
        return false
      }
      return false
    }

    /**
     * Ask the shell for OS fullscreen so the picker shows the active display's
     * capture at its native size, the way a desktop chat app's screenshot tool
     * does, instead of shrinking it into the window. The wait is bounded: a
     * refused or stalled transition keeps windowed mode.
     * @returns whether the document is fullscreen now.
     */
    function requestPickerFullscreen() {
      try {
        const element = document.documentElement
        if (element === null || element === undefined || typeof element.requestFullscreen !== 'function') {
          return Promise.resolve(false)
        }
        const request = Promise.resolve(element.requestFullscreen({ navigationUI: 'hide' }))
          .then(() => true, () => false)
        const bounded = new Promise((resolve) => {
          window.setTimeout(() => { resolve(document.fullscreenElement !== null) }, 1200)
        })
        return Promise.race([request, bounded])
      } catch {
        return Promise.resolve(false)
      }
    }

    /** Leave fullscreen only when this control is the one that entered it. */
    function exitPickerFullscreen() {
      try {
        if (document.fullscreenElement === null) return
        const result = document.exitFullscreen()
        if (result !== undefined && result !== null && typeof result.catch === 'function') result.catch(() => {})
      } catch {
        // The window already left fullscreen.
      }
    }

    //#endregion

    //#region view

    /** Crop-frame icon matching the composer's 14px glyphs. */
    function ScreenshotIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.2 5.6V3.8c0-.9.7-1.6 1.6-1.6h1.8' }),
        h('path', { d: 'M10.4 2.2h1.8c.9 0 1.6.7 1.6 1.6v1.8' }),
        h('path', { d: 'M13.8 10.4v1.8c0 .9-.7 1.6-1.6 1.6h-1.8' }),
        h('path', { d: 'M5.6 13.8H3.8c-.9 0-1.6-.7-1.6-1.6v-1.8' }),
        h('circle', { cx: 8, cy: 8, r: 2.1 }),
      )
    }

    /**
     * Full-window region picker over the captured displays.
     * @param props - the capture session, translate function, and settle callbacks.
     * @returns the picker portal.
     */
    function RegionPicker(props) {
      const { shot, copy } = props
      const displays = shot.displays
      const active = shot.active
      const current = displays[active]
      const overlayRef = React.useRef(null)
      const imageRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const cancelRef = React.useRef(props.onCancel)
      const confirmRef = React.useRef(() => undefined)
      const switchRef = React.useRef(props.onSelectDisplay)
      const [frame, setFrame] = React.useState(null)
      const [selections, setSelections] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      cancelRef.current = props.onCancel
      switchRef.current = props.onSelectDisplay
      const selection = selections[active] ?? null
      const setSelection = React.useCallback((next) => {
        setSelections((previous) => {
          const updated = { ...previous }
          if (next === null) delete updated[active]
          else updated[active] = next
          return updated
        })
      }, [active])

      /** Track the displayed image rectangle; a layout change invalidates the frame. */
      const measure = React.useCallback(() => {
        const image = imageRef.current
        if (image === null) return
        const rect = image.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        setFrame((previous) => previous !== null &&
          previous.display === active &&
          previous.left === rect.left &&
          previous.top === rect.top &&
          previous.width === rect.width &&
          previous.height === rect.height
          ? previous
          : { display: active, left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      }, [active])

      React.useLayoutEffect(() => {
        measure()
        const image = imageRef.current
        if (image === null || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => { measure() })
        observer.observe(image)
        return () => { observer.disconnect() }
      }, [measure])

      React.useEffect(() => {
        const onResize = () => { measure() }
        window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('resize', onResize) }
      }, [measure])

      /** Pointer position inside the image rectangle, clamped to its edges. */
      const pointAt = React.useCallback((event) => {
        const currentFrame = frame
        if (currentFrame === null || currentFrame.display !== active) return null
        return {
          x: clamp(event.clientX - currentFrame.left, 0, currentFrame.width),
          y: clamp(event.clientY - currentFrame.top, 0, currentFrame.height),
        }
      }, [active, frame])

      React.useEffect(() => {
        const onPointerMove = (event) => {
          const drag = dragRef.current
          if (drag === null) return
          const point = pointAt(event)
          if (point === null) return
          drag.moved = true
          setSelection(normalizeSelection(drag.start, point))
        }
        const onPointerUp = () => {
          const drag = dragRef.current
          if (drag === null) return
          dragRef.current = null
          if (!drag.moved) setSelection(null)
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
        return () => {
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('pointercancel', onPointerUp)
        }
      }, [pointAt, setSelection])

      /** Crop the selected region of the active display at source resolution. */
      const confirm = React.useCallback(async () => {
        const area = selection
        const currentFrame = frame
        if (busy || area === null || currentFrame === null || currentFrame.display !== active) return
        if (area.width < MIN_SELECTION_PX || area.height < MIN_SELECTION_PX) return
        setBusy(true)
        setError(null)
        try {
          const scaleX = current.width / currentFrame.width
          const scaleY = current.height / currentFrame.height
          const sourceX = clamp(Math.round(area.x * scaleX), 0, current.width - 1)
          const sourceY = clamp(Math.round(area.y * scaleY), 0, current.height - 1)
          const sourceWidth = clamp(Math.round(area.width * scaleX), 1, current.width - sourceX)
          const sourceHeight = clamp(Math.round(area.height * scaleY), 1, current.height - sourceY)
          const canvas = document.createElement('canvas')
          canvas.width = sourceWidth
          canvas.height = sourceHeight
          const context = canvas.getContext('2d')
          if (context === null) throw new Error(copy('failed', { reason: 'canvas unavailable' }))
          context.drawImage(current.image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight)
          const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png') })
          if (blob === null) throw new Error(copy('insertFailed'))
          await props.onConfirm(blob)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setBusy(false)
        }
      }, [active, busy, copy, current, frame, props, selection])
      confirmRef.current = confirm

      React.useEffect(() => {
        const previous = document.activeElement
        const node = overlayRef.current
        if (node !== null) node.focus({ preventScroll: true })
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancelRef.current()
            return
          }
          if (event.key === 'Tab' && displays.length > 1) {
            event.preventDefault()
            event.stopPropagation()
            switchRef.current((active + 1) % displays.length)
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.stopPropagation()
            confirmRef.current()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
          if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
        }
      }, [])

      React.useEffect(() => {
        const node = overlayRef.current
        if (node === null) return undefined
        const onWheel = (event) => { event.preventDefault() }
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => { node.removeEventListener('wheel', onWheel) }
      }, [])

      const startDrag = (event) => {
        if (event.button !== 0 || busy) return
        const point = pointAt(event)
        if (point === null) return
        dragRef.current = { start: point, moved: false }
        setSelection({ x: point.x, y: point.y, width: 0, height: 0 })
        event.preventDefault()
      }

      const area = selection
      const scaleX = frame === null || frame.display !== active ? 1 : current.width / frame.width
      const scaleY = frame === null || frame.display !== active ? 1 : current.height / frame.height
      const sizeText = area === null
        ? null
        : copy('size', {
          width: Math.max(1, Math.round(area.width * scaleX)),
          height: Math.max(1, Math.round(area.height * scaleY)),
        })
      const canConfirm = area !== null && frame !== null && frame.display === active && !busy &&
        area.width >= MIN_SELECTION_PX && area.height >= MIN_SELECTION_PX
      const hintText = displays.length > 1 ? `${copy('hint')} · ${copy('switchHint')}` : copy('hint')

      return ReactDOM.createPortal(
        h('div', {
          ref: overlayRef,
          tabIndex: -1,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': copy('button'),
          onPointerDown: startDrag,
          onDoubleClick: () => { confirmRef.current() },
          onContextMenu: (event) => {
            event.preventDefault()
            cancelRef.current()
          },
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: OVERLAY_Z_INDEX,
            overflow: 'hidden',
            outline: 'none',
            cursor: 'crosshair',
            background: 'rgba(0, 0, 0, 0.45)',
            userSelect: 'none',
          },
        },
          h('div', {
            style: {
              position: 'fixed',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            },
          },
            h('img', {
              key: current.index,
              ref: imageRef,
              src: current.url,
              alt: '',
              draggable: false,
              onLoad: measure,
              style: {
                maxWidth: '100vw',
                maxHeight: '100vh',
                display: 'block',
                pointerEvents: 'none',
              },
            }),
          ),
          area !== null && frame !== null && frame.display === active && h('div', {
            style: {
              position: 'fixed',
              left: frame.left + area.x,
              top: frame.top + area.y,
              width: area.width,
              height: area.height,
              boxShadow: '0 0 0 100vmax rgba(0, 0, 0, 0.45)',
              border: '1px solid var(--dsw-alias-brand-primary, #4d6bfe)',
              pointerEvents: 'none',
            },
          }),
          sizeText !== null && area !== null && frame !== null && frame.display === active && h('div', {
            style: {
              position: 'fixed',
              left: frame.left + area.x,
              top: Math.max(8, frame.top + area.y - 26),
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'var(--dsw-alias-tooltip-bg, rgba(0, 0, 0, 0.8))',
              color: 'var(--dsw-alias-tooltip-label, #fff)',
              font: '12px/18px system-ui, sans-serif',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            },
          }, sizeText),
          error !== null && h('div', {
            role: 'alert',
            style: {
              position: 'fixed',
              top: '24px',
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '6px 12px',
              borderRadius: '8px',
              background: 'var(--dsw-alias-toast-bg, rgba(0, 0, 0, 0.85))',
              color: 'var(--dsw-alias-toast-label, #fff)',
              font: '12px/18px system-ui, sans-serif',
            },
          }, error),
          h('div', {
            onPointerDown: (event) => { event.stopPropagation() },
            onDoubleClick: (event) => { event.stopPropagation() },
            style: {
              position: 'fixed',
              bottom: '24px',
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 12px',
              borderRadius: '12px',
              background: 'var(--dsw-alias-bg-layer-1, #fff)',
              boxShadow: '0 8px 28px rgba(0, 0, 0, 0.35)',
              color: 'var(--dsw-alias-label-primary, #111)',
              font: '12px/18px system-ui, sans-serif',
              cursor: 'default',
            },
          },
            displays.length > 1 && h('div', {
              role: 'group',
              'aria-label': copy('display', { index: active + 1 }),
              style: { display: 'flex', alignItems: 'center', gap: '4px', flex: 'none' },
            },
              displays.map((display, position) => h('button', {
                key: display.index,
                type: 'button',
                'aria-label': copy('display', { index: position + 1 }),
                'aria-pressed': position === active ? 'true' : 'false',
                title: `${copy('display', { index: position + 1 })} · ${display.width} × ${display.height}`,
                onClick: () => { switchRef.current(position) },
                style: {
                  width: '22px',
                  height: '22px',
                  padding: 0,
                  border: 'none',
                  borderRadius: '999px',
                  fontFamily: 'inherit',
                  fontSize: '11px',
                  lineHeight: '22px',
                  cursor: 'pointer',
                  background: position === active
                    ? 'var(--dsw-alias-button-primary-fill, #4d6bfe)'
                    : 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))',
                  color: position === active
                    ? 'var(--dsw-alias-label-primary-foreground, #fff)'
                    : 'var(--dsw-alias-label-secondary, #555)',
                },
              }, String(position + 1))),
            ),
            displays.length > 1 && h('span', {
              'aria-hidden': 'true',
              style: { width: '1px', height: '16px', background: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', flex: 'none' },
            }),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary, #555)' } }, hintText),
            h('button', {
              type: 'button',
              onClick: () => { cancelRef.current() },
              style: {
                ...TOOL_BUTTON,
                background: 'var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2, #eee))',
                color: 'var(--dsw-alias-label-primary, #111)',
                cursor: 'pointer',
              },
            }, copy('cancel')),
            h('button', {
              type: 'button',
              disabled: !canConfirm,
              onClick: () => { confirmRef.current() },
              style: {
                ...TOOL_BUTTON,
                background: canConfirm ? 'var(--dsw-alias-button-primary-fill, #4d6bfe)' : 'var(--dsw-alias-bg-layer-2, #eee)',
                color: canConfirm ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-tertiary, #999)',
                opacity: busy ? 0.6 : 1,
                cursor: canConfirm ? 'pointer' : 'default',
              },
            }, copy('confirm')),
          ),
        ),
        document.body,
      )
    }

    //#endregion

    //#region control

    /**
     * Build the composer control bound to this plugin context.
     * @param ctx - plugin-owned Client context.
     * @param copy - bound translate function for this namespace.
     * @returns the slot component.
     */
    function createControl(ctx, copy) {
      return function ScreenshotControl(props) {
        const t = typeof props.t === 'function' ? props.t : copy
        const [hover, setHover] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [shot, setShot] = React.useState(null)
        const [notice, setNotice] = React.useState(null)
        const noticeTimer = React.useRef(0)
        // Whether the page was already fullscreen before this picking session:
        // only a fullscreen this control entered is ever left again.
        const startedFullscreenRef = React.useRef(false)

        React.useEffect(() => () => {
          window.clearTimeout(noticeTimer.current)
          if (!startedFullscreenRef.current) exitPickerFullscreen()
        }, [])

        const showNotice = React.useCallback((text) => {
          setNotice(text)
          window.clearTimeout(noticeTimer.current)
          noticeTimer.current = window.setTimeout(() => { setNotice(null) }, 5000)
        }, [])

        const closePicker = React.useCallback(() => {
          if (!startedFullscreenRef.current) exitPickerFullscreen()
          setShot(null)
        }, [])

        /** Put one confirmed PNG into the current draft through the composer's own pipeline. */
        const attach = React.useCallback(async (blob) => {
          const conversation = ctx.get('conversation')
          if (conversation === undefined || conversation === null || typeof conversation.createDrafts !== 'function') {
            throw new Error(t('unavailable'))
          }
          const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
          const file = new File([blob], `screenshot-${stamp}.png`, { type: 'image/png' })
          const drafts = conversation.createDrafts(props.sessionId, [file], acceptsImageUploads(ctx, props.sessionId))
          if (!Array.isArray(drafts) || drafts.length === 0) throw new Error(t('insertFailed'))
          const ids = drafts.map((draft) => draft.id)
          if (!addDraftAttachments(conversation, props.inputActions, props.sessionId, ids)) {
            if (typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(drafts)
            throw new Error(t('insertFailed'))
          }
        }, [props.inputActions, props.sessionId, t])

        /** Capture every display, then open the region picker over the page. */
        const capture = React.useCallback(async () => {
          if (busy) return
          startedFullscreenRef.current = document.fullscreenElement !== null
          setBusy(true)
          try {
            const response = await fetch(CAPTURE_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
            const mediaType = String(response.headers.get('content-type') ?? '')
            let payload = null
            if (!response.ok) {
              try {
                payload = await response.json()
              } catch {
                // A refused request may carry no JSON body at all.
              }
              const reason = payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
                ? payload.error
                : `HTTP ${String(response.status)}`
              throw new Error(reason)
            }
            const displays = []
            if (mediaType.includes('image/png')) {
              // A Host that predates the multi-display protocol answers one PNG.
              const url = await blobToDataUrl(await response.blob())
              const image = await decodeImage(url)
              displays.push({
                index: 0,
                x: 0,
                y: 0,
                width: image.naturalWidth,
                height: image.naturalHeight,
                primary: true,
                cursor: true,
                url,
                image,
              })
            } else {
              payload = await response.json()
              const entries = payload !== null && typeof payload === 'object' && Array.isArray(payload.displays) ? payload.displays : []
              for (const entry of entries) {
                if (entry === null || typeof entry !== 'object' || typeof entry.image !== 'string') continue
                const width = Number(entry.width)
                const height = Number(entry.height)
                if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
                displays.push({
                  index: Number.isFinite(Number(entry.index)) ? Number(entry.index) : displays.length,
                  x: Number.isFinite(Number(entry.x)) ? Number(entry.x) : 0,
                  y: Number.isFinite(Number(entry.y)) ? Number(entry.y) : 0,
                  width,
                  height,
                  primary: entry.primary === true,
                  cursor: entry.cursor === true,
                  url: entry.image,
                  image: await decodeImage(entry.image),
                })
              }
            }
            if (displays.length === 0) throw new Error('the capture reported no displays')
            // The display under the pointer is the one the window sits on, so it
            // opens first; the rest are one Tab away.
            const initial = displays.findIndex((display) => display.cursor === true)
            // The display is already frozen in the capture, so entering
            // fullscreen now cannot change what was captured: it only lets the
            // picker show that capture one-to-one with the real screen.
            await requestPickerFullscreen()
            setShot({ displays, active: initial < 0 ? 0 : initial })
          } catch (cause) {
            if (!startedFullscreenRef.current) exitPickerFullscreen()
            showNotice(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
          } finally {
            setBusy(false)
          }
        }, [busy, showNotice, t])

        const selectDisplay = React.useCallback((index) => {
          setShot((current) => {
            if (current === null || index < 0 || index >= current.displays.length || index === current.active) return current
            return { ...current, active: index }
          })
        }, [])

        return h(React.Fragment, null,
          h('style', { dangerouslySetInnerHTML: { __html: SPINNER_KEYFRAMES } }),
          h('button', {
            type: 'button',
            'aria-label': t('button'),
            title: t('button'),
            'aria-busy': busy ? 'true' : undefined,
            disabled: busy,
            onClick: capture,
            onMouseEnter: () => { setHover(true) },
            onMouseLeave: () => { setHover(false) },
            style: {
              width: '28px',
              height: '28px',
              flex: 'none',
              display: 'grid',
              placeItems: 'center',
              padding: 0,
              border: 'none',
              borderRadius: '999px',
              transition: 'background-color 0.1s',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.5 : 1,
              background: hover && !busy
                ? 'var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-specific-selector))'
                : 'var(--dsw-specific-selector, var(--dsw-alias-bg-layer-2))',
              color: 'var(--dsw-alias-label-primary, #111)',
            },
          }, busy
            ? h('span', {
              style: {
                display: 'block',
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                border: '2px solid var(--dsw-alias-label-tertiary, #999)',
                borderTopColor: 'transparent',
                animation: 'dsh-screenshot-spin 0.8s linear infinite',
              },
            })
            : h(ScreenshotIcon)),
          shot !== null && h(RegionPicker, {
            shot,
            copy: t,
            onCancel: closePicker,
            onSelectDisplay: selectDisplay,
            onConfirm: async (blob) => {
              await attach(blob)
              closePicker()
            },
          }),
          notice !== null && ReactDOM.createPortal(
            h('div', {
              role: 'status',
              style: {
                position: 'fixed',
                bottom: '96px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: OVERLAY_Z_INDEX + 2,
                maxWidth: '420px',
                padding: '8px 14px',
                borderRadius: '10px',
                background: 'var(--dsw-alias-toast-bg, rgba(0, 0, 0, 0.85))',
                color: 'var(--dsw-alias-toast-label, #fff)',
                font: '12px/18px system-ui, sans-serif',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
              },
            }, notice),
            document.body,
          ),
        )
      }
    }

    //#endregion

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTIONARIES.en), 'screenshot-tool: English dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTIONARIES.zh), 'screenshot-tool: Chinese dictionary')
        const copy = ctx.locale.bind(NS)
        const Control = createControl(ctx, copy)
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'screenshot-tool',
          order: 0,
          label: () => copy('button'),
          locale: NS,
        }, Control))
      },
    }
  },
})
