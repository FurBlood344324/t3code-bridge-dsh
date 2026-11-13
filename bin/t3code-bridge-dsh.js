#!/usr/bin/env node
// Entry point T3 Code spawns as `commandPath` with `commandArgs: ["launch", "<profile>"]`.
import { main } from '../src/cli.js';

process.exit(await main(process.argv.slice(2)));
