## Summary

<!-- What does this change and why? -->

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ Feature
- [ ] ♻️ Refactor / perf
- [ ] 📝 Docs / chore

## Testing

- [ ] `npm run build` passes (strict typecheck)
- [ ] `npm test` passes
- [ ] Manually verified with `npm run dev`

## Checklist

- [ ] Relative imports use explicit `.js` extensions (ESM)
- [ ] No user-facing strings hardcoded outside `src/strings.ts`
- [ ] Per-thread behavior resolved via `getEffectiveConfig(...)`, not raw `yamlConfig.*`
- [ ] No new blocking network calls added to the `runJulesStream` / `messageCreate` hot paths
