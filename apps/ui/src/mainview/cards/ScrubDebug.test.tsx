import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((r) => setTimeout(r, 0))
  await GlobalRegistrator.unregister()
})

test("bare range input without label", () => {
  const ran: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() =>
    createRoot(host).render(
      <input
        type="range"
        min={1000}
        max={8900}
        value={4000}
        aria-label="Replay cursor"
        data-testid="scrub"
        onChange={(event) => ran.push(event.target.value)}
      />
    )
  )
  const scrubber = host.querySelector<HTMLInputElement>("[data-testid=\"scrub\"]")!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(scrubber, "5200")
  flushSync(() => scrubber.dispatchEvent(new Event("input", { bubbles: true })))
  console.log("ran nolabel:", ran)
  expect(ran).toEqual(["5200"])
})

test("bare range input in label", () => {
  const ran: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() =>
    createRoot(host).render(
      <label>
        Replay
        <input
          type="range"
          min={1000}
          max={8900}
          value={4000}
          aria-label="Replay cursor"
          data-testid="scrub2"
          onChange={(event) => ran.push(event.target.value)}
        />
      </label>
    )
  )
  const scrubber = host.querySelector<HTMLInputElement>("[data-testid=\"scrub2\"]")!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(scrubber, "5200")
  flushSync(() => scrubber.dispatchEvent(new Event("input", { bubbles: true })))
  console.log("ran label:", ran)
  expect(ran).toEqual(["5200"])
})
