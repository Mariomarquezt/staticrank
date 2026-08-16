// Single indirection point for the Instatic plugin SDK.
//
// The SDK has no published package yet (upstream gap: it only resolves
// inside the Instatic monorepo), so every TS import in this repo goes
// through this one file and `scripts/build.sh` rewrites the path below to
// point at your Instatic checkout ($INSTATIC).
//
// Editing this by hand is fine too — point it at
// <your-instatic-checkout>/src/core/plugin-sdk/index.ts.
export * from 'INSTATIC_SDK_PATH'
