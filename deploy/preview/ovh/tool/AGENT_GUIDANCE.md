# Atrium preview guidance

1. Commit your previewable changes and push the branch to `origin` first. The
   tool refuses to create a preview from an unpushed ref.
2. Run:
   `atrium-preview create --repo useatrium/atrium --ref <branch>`
3. Creation normally takes several minutes. The command polls until ready or
   failed. Report the preview id, resolved commit SHA, URL, and expiry when
   ready; on failure, report the failed phase and message. If polling times out,
   continue with `atrium-preview status <id>`.
4. When the preview is no longer needed, offer to run
   `atrium-preview destroy <id>`.

Keep progress in one work/status surface and update it as state changes. Do not
spam separate progress messages.
