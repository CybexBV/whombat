/** CSS modules as both Vite builds (the web app, the box's console) and the shots' bundler give them: class names. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
