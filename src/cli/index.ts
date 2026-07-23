#!/usr/bin/env node
import { runCli } from "./program.js";

const result = await runCli(process.argv.slice(2), { cwd: process.cwd() });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
