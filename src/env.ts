// Entry points import this first so a local .env reaches process.env. Library code never loads it,
// so an app that embeds KINETIC keeps control of its own environment.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}
