#!/usr/bin/env node
import { runCli } from './cli.js'

const result = runCli(process.argv.slice(2))
const stream = result.exitCode === 0 ? process.stdout : process.stderr

stream.write(`${result.output}\n`)
process.exitCode = result.exitCode
