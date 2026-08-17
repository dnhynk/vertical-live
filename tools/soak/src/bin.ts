#!/usr/bin/env node
import { runCli } from './cli.js'

const result = await runCli(process.argv.slice(2))
process.stdout.write(`${result.output}\n`)
process.exitCode = result.exitCode
