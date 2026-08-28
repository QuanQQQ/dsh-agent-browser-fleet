export class FleetUiController {
  private opened = false
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly snapshot = (): boolean => this.opened
  open(): void { this.set(true) }
  close(): void { this.set(false) }
  toggle(): void { this.set(!this.opened) }
  private set(value: boolean): void {
    if (value === this.opened) return
    this.opened = value
    for (const listener of this.listeners) listener()
  }
}
