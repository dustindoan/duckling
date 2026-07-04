// Empty stub module.
//
// Used as a tsconfig `paths` target for upstream ente imports that the
// upload/auth pipeline does NOT reach at runtime (React, MUI, Emotion,
// ente-contacts-web). Bun's bundler will tree-shake unreached code, but tsc
// still walks the type surface, so we redirect those imports here to keep
// the type checker quiet.
//
// If a module aliased to this file starts being IMPORTED-AND-CALLED at
// runtime, the resulting `undefined is not a function` is the signal to
// remove the alias and either polyfill the surface or factor it out.
export {};
export default {};
