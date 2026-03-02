import fs from 'node:fs'
import { resolve } from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import { cancel, confirm, intro, isCancel, log } from '@clack/prompts'
import chalk from 'chalk'
import semver from 'semver'

import {
  SUPPORTED_PACKAGE_MANAGERS,
  addToApp,
  compileAddOn,
  compileStarter,
  createApp,
  devAddOn,
  getAllAddOns,
  getFrameworkByName,
  getFrameworks,
  initAddOn,
  initStarter,
} from '@tanstack/create'
import {
  LIBRARY_GROUPS,
  fetchDocContent,
  fetchLibraries,
  fetchPartners,
  searchTanStackDocs,
} from './discovery.js'

import { promptForAddOns, promptForCreateOptions } from './options.js'
import {
  normalizeOptions,
  validateDevWatchOptions,
  validateLegacyCreateFlags,
} from './command-line.js'

import { createUIEnvironment } from './ui-environment.js'
import { DevWatchManager } from './dev-watch.js'

import type { CliOptions } from './types.js'
import type {
  FrameworkDefinition,
  Options,
  PackageManager,
} from '@tanstack/create'

// Read version from package.json
const packageJsonPath = new URL('../package.json', import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const VERSION = packageJson.version

export function cli({
  name,
  appName,
  forcedAddOns = [],
  forcedDeployment,
  defaultFramework,
  frameworkDefinitionInitializers,
  showDeploymentOptions = false,
  legacyAutoCreate = false,
  defaultRouterOnly = false,
}: {
  name: string
  appName: string
  forcedAddOns?: Array<string>
  forcedDeployment?: string
  defaultFramework?: string
  frameworkDefinitionInitializers?: Array<() => FrameworkDefinition>
  showDeploymentOptions?: boolean
  legacyAutoCreate?: boolean
  defaultRouterOnly?: boolean
}) {
  const environment = createUIEnvironment(appName, false)

  const program = new Command()

  async function confirmTargetDirectorySafety(
    targetDir: string,
    forced?: boolean,
  ) {
    if (forced) {
      return
    }

    if (!fs.existsSync(targetDir)) {
      return
    }

    if (!fs.statSync(targetDir).isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${targetDir}`)
    }

    if (fs.readdirSync(targetDir).length === 0) {
      return
    }

    const shouldContinue = await confirm({
      message: `Target directory "${targetDir}" already exists and is not empty. Continue anyway?`,
      initialValue: false,
    })

    if (isCancel(shouldContinue) || !shouldContinue) {
      cancel('Operation cancelled.')
      process.exit(0)
    }
  }

  const availableFrameworks = getFrameworks().map((f) => f.name)

  function resolveBuiltInDevWatchPath(frameworkId: string): string {
    const candidates = [
      resolve(process.cwd(), 'packages/create/src/frameworks', frameworkId),
      resolve(process.cwd(), '../create/src/frameworks', frameworkId),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    return candidates[0]
  }

  async function startDevWatchMode(projectName: string, options: CliOptions) {
    // Validate dev watch options
    const validation = validateDevWatchOptions({ ...options, projectName })
    if (!validation.valid) {
      console.error(validation.error)
      process.exit(1)
    }

    // Enter dev watch mode
    if (!projectName && !options.targetDir) {
      console.error('Project name/target directory is required for dev watch mode')
      process.exit(1)
    }

    if (!options.framework) {
      console.error('Failed to detect framework')
      process.exit(1)
    }

    const framework = getFrameworkByName(options.framework)
    if (!framework) {
      console.error('Failed to detect framework')
      process.exit(1)
    }

    // First, create the app normally using the standard flow
    const normalizedOpts = await normalizeOptions(
      {
        ...options,
        projectName,
        framework: framework.id,
      },
      forcedAddOns,
    )

    if (!normalizedOpts) {
      throw new Error('Failed to normalize options')
    }

    normalizedOpts.targetDir =
      options.targetDir || resolve(process.cwd(), projectName)

    // Create the initial app with minimal output for dev watch mode
    console.log(chalk.bold('\ndev-watch'))
    console.log(chalk.gray('├─') + ' ' + `creating initial ${appName} app...`)
    if (normalizedOpts.install !== false) {
      console.log(
        chalk.gray('├─') + ' ' + chalk.yellow('⟳') + ' installing packages...',
      )
    }
    const silentEnvironment = createUIEnvironment(appName, true)
    await confirmTargetDirectorySafety(normalizedOpts.targetDir, options.force)
    await createApp(silentEnvironment, normalizedOpts)
    console.log(chalk.gray('└─') + ' ' + chalk.green('✓') + ` app created`)

    // Now start the dev watch mode
    const manager = new DevWatchManager({
      watchPath: options.devWatch!,
      targetDir: normalizedOpts.targetDir,
      framework,
      cliOptions: normalizedOpts,
      packageManager: normalizedOpts.packageManager,
      runDevCommand: options.runDev,
      environment,
      frameworkDefinitionInitializers,
    })

    await manager.start()
  }

  const toolchains = new Set<string>()
  for (const framework of getFrameworks()) {
    for (const addOn of framework.getAddOns()) {
      if (addOn.type === 'toolchain') {
        toolchains.add(addOn.id)
      }
    }
  }

  const deployments = new Set<string>()
  for (const framework of getFrameworks()) {
    for (const addOn of framework.getAddOns()) {
      if (addOn.type === 'deployment') {
        deployments.add(addOn.id)
      }
    }
  }

  // Mode is always file-router (TanStack Start)
  const defaultMode = 'file-router'
  const categoryAliases: Record<string, string> = {
    db: 'database',
    postgres: 'database',
    sql: 'database',
    login: 'auth',
    authentication: 'auth',
    hosting: 'deployment',
    deploy: 'deployment',
    serverless: 'deployment',
    errors: 'monitoring',
    logging: 'monitoring',
    content: 'cms',
    'api-keys': 'api',
    grid: 'data-grid',
    review: 'code-review',
    courses: 'learning',
  }

  function printJson(data: unknown) {
    console.log(JSON.stringify(data, null, 2))
  }

  function parsePositiveInteger(value: string) {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new InvalidArgumentError('Value must be a positive integer')
    }
    return parsed
  }

  program
    .name(name)
    .description(`${appName} CLI`)
    .version(VERSION, '-v, --version', 'output the current version')

  // Helper to create the create command action handler
  async function handleCreate(projectName: string, options: CliOptions) {
    const legacyCreateFlags = validateLegacyCreateFlags(options)
    if (legacyCreateFlags.error) {
      log.error(legacyCreateFlags.error)
      process.exit(1)
    }

    for (const warning of legacyCreateFlags.warnings) {
      log.warn(warning)
    }

    if (options.listAddOns) {
      const addOns = await getAllAddOns(
        getFrameworkByName(options.framework || defaultFramework || 'React')!,
        defaultMode,
      )
      const visibleAddOns = addOns.filter((a) => !forcedAddOns.includes(a.id))
      if (options.json) {
        printJson(
          visibleAddOns.map((addOn) => ({
            id: addOn.id,
            name: addOn.name,
            description: addOn.description,
            type: addOn.type,
            category: addOn.category,
            phase: addOn.phase,
            modes: addOn.modes,
            link: addOn.link,
            warning: addOn.warning,
            exclusive: addOn.exclusive,
            dependsOn: addOn.dependsOn,
            options: addOn.options,
          })),
        )
        return
      }

      let hasConfigurableAddOns = false
      for (const addOn of visibleAddOns) {
        const hasOptions =
          addOn.options && Object.keys(addOn.options).length > 0
        const optionMarker = hasOptions ? '*' : ' '
        if (hasOptions) hasConfigurableAddOns = true
        console.log(
          `${optionMarker} ${chalk.bold(addOn.id)}: ${addOn.description}`,
        )
      }
      if (hasConfigurableAddOns) {
        console.log('\n* = has configuration options')
      }
      return
    }

    if (options.addonDetails) {
      const addOns = await getAllAddOns(
        getFrameworkByName(options.framework || defaultFramework || 'React')!,
        defaultMode,
      )
      const addOn =
        addOns.find((a) => a.id === options.addonDetails) ??
        addOns.find(
          (a) =>
            a.id.toLowerCase() === options.addonDetails!.toLowerCase(),
        )
      if (!addOn) {
        console.error(`Add-on '${options.addonDetails}' not found`)
        process.exit(1)
      }

      if (options.json) {
        const files = await addOn.getFiles()
        printJson({
          id: addOn.id,
          name: addOn.name,
          description: addOn.description,
          type: addOn.type,
          category: addOn.category,
          phase: addOn.phase,
          modes: addOn.modes,
          link: addOn.link,
          warning: addOn.warning,
          exclusive: addOn.exclusive,
          dependsOn: addOn.dependsOn,
          options: addOn.options,
          routes: addOn.routes,
          packageAdditions: addOn.packageAdditions,
          shadcnComponents: addOn.shadcnComponents,
          integrations: addOn.integrations,
          readme: addOn.readme,
          files,
          author: addOn.author,
          version: addOn.version,
          license: addOn.license,
        })
        return
      }

      console.log(
        `${chalk.bold.cyan('Add-on Details:')} ${chalk.bold(addOn.name)}`,
      )
      console.log(`${chalk.bold('ID:')} ${addOn.id}`)
      console.log(`${chalk.bold('Description:')} ${addOn.description}`)
      console.log(`${chalk.bold('Type:')} ${addOn.type}`)
      console.log(`${chalk.bold('Phase:')} ${addOn.phase}`)
      console.log(`${chalk.bold('Supported Modes:')} ${addOn.modes.join(', ')}`)

      if (addOn.link) {
        console.log(`${chalk.bold('Link:')} ${chalk.blue(addOn.link)}`)
      }

      if (addOn.dependsOn && addOn.dependsOn.length > 0) {
        console.log(
          `${chalk.bold('Dependencies:')} ${addOn.dependsOn.join(', ')}`,
        )
      }

      if (addOn.options && Object.keys(addOn.options).length > 0) {
        console.log(`\n${chalk.bold.yellow('Configuration Options:')}`)
        for (const [optionName, option] of Object.entries(addOn.options)) {
          if ('type' in option) {
            const opt = option as any
            console.log(`  ${chalk.bold(optionName)}:`)
            console.log(`    Label: ${opt.label}`)
            if (opt.description) {
              console.log(`    Description: ${opt.description}`)
            }
            console.log(`    Type: ${opt.type}`)
            console.log(`    Default: ${opt.default}`)
            if (opt.type === 'select' && opt.options) {
              console.log(`    Available values:`)
              for (const choice of opt.options) {
                console.log(`      - ${choice.value}: ${choice.label}`)
              }
            }
          }
        }
      } else {
        console.log(`\n${chalk.gray('No configuration options available')}`)
      }

      if (addOn.routes && addOn.routes.length > 0) {
        console.log(`\n${chalk.bold.green('Routes:')}`)
        for (const route of addOn.routes) {
          console.log(`  ${chalk.bold(route.url)} (${route.name})`)
          console.log(`    File: ${route.path}`)
        }
      }
      return
    }

    if (options.devWatch) {
      await startDevWatchMode(projectName, options)
      return
    }

    try {
      const cliOptions = {
        projectName,
        ...options,
      } as CliOptions

      if (defaultRouterOnly && cliOptions.routerOnly === undefined) {
        cliOptions.routerOnly = true
      }

      if (
        cliOptions.routerOnly !== true &&
        cliOptions.template &&
        ['file-router', 'typescript', 'tsx', 'javascript', 'js', 'jsx'].includes(
          cliOptions.template.toLowerCase(),
        ) &&
        cliOptions.template.toLowerCase() !== 'file-router'
      ) {
        cliOptions.routerOnly = true
      }

      cliOptions.framework = getFrameworkByName(
        options.framework || defaultFramework || 'React',
      )!.id

      let finalOptions: Options | undefined
      if (cliOptions.interactive || cliOptions.addOns === true) {
        cliOptions.addOns = true
      } else {
        finalOptions = await normalizeOptions(
          cliOptions,
          forcedAddOns,
          { forcedDeployment },
        )
      }

      if (finalOptions) {
        intro(`Creating a new ${appName} app in ${projectName}...`)
      } else {
        intro(`Let's configure your ${appName} application`)
        finalOptions = await promptForCreateOptions(cliOptions, {
          forcedAddOns,
          showDeploymentOptions,
        })
      }

      if (!finalOptions) {
        throw new Error('No options were provided')
      }

      ;(finalOptions as Options & { routerOnly?: boolean }).routerOnly =
        !!cliOptions.routerOnly

      // Determine target directory:
      // 1. Use --target-dir if provided
      // 2. Use targetDir from normalizeOptions if set (handles "." case)
      // 3. If original projectName was ".", use current directory
      // 4. Otherwise, use project name as subdirectory
      if (options.targetDir) {
        finalOptions.targetDir = options.targetDir
      } else if (finalOptions.targetDir) {
        // Keep the targetDir from normalizeOptions (handles "." case)
      } else if (projectName === '.') {
        finalOptions.targetDir = resolve(process.cwd())
      } else {
        finalOptions.targetDir = resolve(process.cwd(), finalOptions.projectName)
      }

      await confirmTargetDirectorySafety(finalOptions.targetDir, options.force)
      await createApp(environment, finalOptions)
    } catch (error) {
      log.error(
        error instanceof Error ? error.message : 'An unknown error occurred',
      )
      process.exit(1)
    }
  }

  // Helper to configure create command options
  function configureCreateCommand(cmd: Command) {
    cmd.argument('[project-name]', 'name of the project')

    if (!defaultFramework) {
      cmd.option<string>(
        '--framework <type>',
        `project framework (${availableFrameworks.join(', ')})`,
        (value) => {
          if (value.toLowerCase() === 'react-cra') {
            return 'react'
          }

          if (
            !availableFrameworks.some(
              (f) => f.toLowerCase() === value.toLowerCase(),
            )
          ) {
            throw new InvalidArgumentError(
              `Invalid framework: ${value}. Only the following are allowed: ${availableFrameworks.join(', ')}`,
            )
          }
          return value
        },
        defaultFramework || 'React',
      )
    }

    cmd
      .option(
        '--starter [url-or-id]',
        'DEPRECATED: use --template. Initializes from a template URL or built-in id',
        false,
      )
      .option('--template-id <id>', 'initialize using a built-in template id')
      .option(
        '--template [url-or-id]',
        'initialize this project from a template URL or built-in template id',
      )
      .option('--no-install', 'skip installing dependencies')
      .option<PackageManager>(
        `--package-manager <${SUPPORTED_PACKAGE_MANAGERS.join('|')}>`,
        `Explicitly tell the CLI to use this package manager`,
        (value) => {
          if (!SUPPORTED_PACKAGE_MANAGERS.includes(value as PackageManager)) {
            throw new InvalidArgumentError(
              `Invalid package manager: ${value}. The following are allowed: ${SUPPORTED_PACKAGE_MANAGERS.join(
                ', ',
              )}`,
            )
          }
          return value as PackageManager
        },
      )
      .option(
        '--dev-watch <path>',
        'Watch a framework directory for changes and auto-rebuild',
      )
      .option('--run-dev', 'Run the app dev server alongside dev-watch', false)
      .option(
        '--router-only',
        'Use router-only compatibility mode (file-based routing without TanStack Start)',
      )
      .option(
        '--tailwind',
        'Deprecated: compatibility flag; Tailwind is always enabled',
      )
      .option(
        '--no-tailwind',
        'Deprecated: compatibility flag; Tailwind opt-out is ignored',
      )
      .option('--examples', 'include demo/example pages')
      .option('--no-examples', 'exclude demo/example pages')

    if (deployments.size > 0) {
      cmd.option<string>(
        `--deployment <${Array.from(deployments).join('|')}>`,
        `Explicitly tell the CLI to use this deployment adapter`,
        (value) => {
          if (!deployments.has(value)) {
            throw new InvalidArgumentError(
              `Invalid adapter: ${value}. The following are allowed: ${Array.from(
                deployments,
              ).join(', ')}`,
            )
          }
          return value
        },
      )
    }

    if (toolchains.size > 0) {
      cmd
        .option<string>(
          `--toolchain <${Array.from(toolchains).join('|')}>`,
          `Explicitly tell the CLI to use this toolchain`,
          (value) => {
            if (!toolchains.has(value)) {
              throw new InvalidArgumentError(
                `Invalid toolchain: ${value}. The following are allowed: ${Array.from(
                  toolchains,
                ).join(', ')}`,
              )
            }
            return value
          },
        )
        .option('--no-toolchain', 'skip toolchain selection')
    }

    cmd
      .option('--interactive', 'interactive mode', false)
      .option<Array<string> | boolean>(
        '--add-ons [...add-ons]',
        'pick from a list of available add-ons (comma separated list)',
        (value: string) => {
          let addOns: Array<string> | boolean = !!value
          if (typeof value === 'string') {
            addOns = value.split(',').map((addon) => addon.trim())
          }
          return addOns
        },
      )
      .option('--list-add-ons', 'list all available add-ons', false)
      .option(
        '--addon-details <addon-id>',
        'show detailed information about a specific add-on',
      )
      .option('--json', 'output JSON for automation', false)
      .option('--git', 'create a git repository')
      .option('--no-git', 'do not create a git repository')
      .option(
        '--target-dir <path>',
        'the target directory for the application root',
      )
      .option(
        '--add-on-config <config>',
        'JSON string with add-on configuration options',
      )
      .option(
        '-f, --force',
        'force project creation even if the target directory is not empty',
        false,
      )

    return cmd
  }

  // === CREATE SUBCOMMAND ===
  // Creates a TanStack Start app (file-router mode).
  const createCommand = program
    .command('create')
    .description(`Create a new TanStack Start application`)

  configureCreateCommand(createCommand)
  createCommand.action(handleCreate)

  // === DEV SUBCOMMAND ===
  const devCommand = program
    .command('dev')
    .description(
      'Create a sandbox app and watch built-in framework templates/add-ons',
    )

  configureCreateCommand(devCommand)
  devCommand.action(async (projectName: string, options: CliOptions) => {
    const frameworkName = options.framework || defaultFramework || 'React'
    const framework = getFrameworkByName(frameworkName)
    if (!framework) {
      console.error(`Unknown framework: ${frameworkName}`)
      process.exit(1)
    }

    const watchPath = resolveBuiltInDevWatchPath(framework.id)
    const devOptions: CliOptions = {
      ...options,
      framework: framework.name,
      devWatch: watchPath,
      runDev: true,
      install: options.install ?? true,
    }

    await startDevWatchMode(projectName, devOptions)
  })

  // === LIBRARIES SUBCOMMAND ===
  program
    .command('libraries')
    .description('List TanStack libraries')
    .option(
      '--group <group>',
      `filter by group (${LIBRARY_GROUPS.join(', ')})`,
    )
    .option('--json', 'output JSON for automation', false)
    .action(async (options: { group?: string; json: boolean }) => {
      try {
        const data = await fetchLibraries()
        let libraries = data.libraries

        if (
          options.group &&
          Object.prototype.hasOwnProperty.call(data.groups, options.group)
        ) {
          const groupIds = data.groups[options.group]
          libraries = libraries.filter((lib) => groupIds.includes(lib.id))
        }

        const groupName = options.group
          ? data.groupNames[options.group] || options.group
          : 'All Libraries'

        const payload = {
          group: groupName,
          count: libraries.length,
          libraries: libraries.map((lib) => ({
            id: lib.id,
            name: lib.name,
            tagline: lib.tagline,
            description: lib.description,
            frameworks: lib.frameworks,
            latestVersion: lib.latestVersion,
            docsUrl: lib.docsUrl,
            githubUrl: lib.githubUrl,
          })),
        }

        if (options.json) {
          printJson(payload)
          return
        }

        console.log(chalk.bold(groupName))
        for (const lib of payload.libraries) {
          console.log(
            `${chalk.bold(lib.id)} (${lib.latestVersion}) - ${lib.tagline}`,
          )
        }
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
    })

  // === DOC SUBCOMMAND ===
  program
    .command('doc')
    .description('Fetch a TanStack documentation page')
    .argument('<library>', 'library ID (eg. query, router, table)')
    .argument('<path>', 'documentation path (eg. framework/react/overview)')
    .option('--docs-version <version>', 'docs version (default: latest)', 'latest')
    .option('--json', 'output JSON for automation', false)
    .action(
      async (
        libraryId: string,
        path: string,
        options: { docsVersion: string; json: boolean },
      ) => {
        try {
          const data = await fetchLibraries()
          const library = data.libraries.find((l) => l.id === libraryId)

          if (!library) {
            throw new Error(
              `Library "${libraryId}" not found. Use \`tanstack libraries\` to see available libraries.`,
            )
          }

          if (
            options.docsVersion !== 'latest' &&
            !library.availableVersions.includes(options.docsVersion)
          ) {
            throw new Error(
              `Version "${options.docsVersion}" not found for ${library.name}. Available: ${library.availableVersions.join(', ')}`,
            )
          }

          const branch =
            options.docsVersion === 'latest' ||
            options.docsVersion === library.latestVersion
              ? library.latestBranch || 'main'
              : options.docsVersion

          const docsRoot = library.docsRoot || 'docs'
          const filePath = `${docsRoot}/${path}.md`
          const content = await fetchDocContent(library.repo, branch, filePath)

          if (!content) {
            throw new Error(
              `Document not found: ${library.name} / ${path} (version: ${options.docsVersion})`,
            )
          }

          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
          let title = path.split('/').pop() || 'Untitled'
          let docContent = content

          if (frontmatterMatch && frontmatterMatch[1]) {
            const frontmatter = frontmatterMatch[1]
            const titleMatch = frontmatter.match(
              /title:\s*['"]?([^'"\n]+)['"]?/,
            )
            if (titleMatch && titleMatch[1]) {
              title = titleMatch[1]
            }
            docContent = content.slice(frontmatterMatch[0].length).trim()
          }

          const payload = {
            title,
            content: docContent,
            url: `https://tanstack.com/${libraryId}/${options.docsVersion}/docs/${path}`,
            library: library.name,
            version:
              options.docsVersion === 'latest'
                ? library.latestVersion
                : options.docsVersion,
          }

          if (options.json) {
            printJson(payload)
            return
          }

          console.log(chalk.bold(payload.title))
          console.log(chalk.blue(payload.url))
          console.log('')
          console.log(payload.content)
        } catch (error) {
          log.error(error instanceof Error ? error.message : String(error))
          process.exit(1)
        }
      },
    )

  // === SEARCH-DOCS SUBCOMMAND ===
  program
    .command('search-docs')
    .description('Search TanStack documentation')
    .argument('<query>', 'search query')
    .option('--library <id>', 'filter to specific library')
    .option('--framework <name>', 'filter to specific framework')
    .option('--limit <n>', 'max results (default: 10, max: 50)', parsePositiveInteger, 10)
    .option('--json', 'output JSON for automation', false)
    .action(
      async (
        query: string,
        options: {
          library?: string
          framework?: string
          limit: number
          json: boolean
        },
      ) => {
        try {
          const payload = await searchTanStackDocs({
            query,
            library: options.library,
            framework: options.framework,
            limit: options.limit,
          })

          if (options.json) {
            printJson(payload)
            return
          }

          for (const result of payload.results) {
            console.log(
              `${chalk.bold(result.title)} [${result.library}]\n${chalk.blue(result.url)}\n${result.snippet}\n`,
            )
          }
        } catch (error) {
          log.error(error instanceof Error ? error.message : String(error))
          process.exit(1)
        }
      },
    )

  // === ECOSYSTEM SUBCOMMAND ===
  program
    .command('ecosystem')
    .description('List TanStack ecosystem partners')
    .option('--category <category>', 'filter by category')
    .option('--library <id>', 'filter by TanStack library')
    .option('--json', 'output JSON for automation', false)
    .action(
      async (options: { category?: string; library?: string; json: boolean }) => {
        try {
          const data = await fetchPartners()

          let resolvedCategory: string | undefined
          if (options.category) {
            const normalized = options.category.toLowerCase().trim()
            resolvedCategory = categoryAliases[normalized] || normalized
            if (!data.categories.includes(resolvedCategory)) {
              resolvedCategory = undefined
            }
          }

          const library = options.library?.toLowerCase().trim()
          const partners = data.partners
            .filter((partner) =>
              resolvedCategory ? partner.category === resolvedCategory : true,
            )
            .filter((partner) =>
              library ? partner.libraries.some((l) => l === library) : true,
            )
            .map((partner) => ({
              id: partner.id,
              name: partner.name,
              tagline: partner.tagline,
              description: partner.description,
              category: partner.category,
              categoryLabel: partner.categoryLabel,
              url: partner.url,
              libraries: partner.libraries,
            }))

          const payload = {
            query: {
              category: options.category,
              categoryResolved: resolvedCategory,
              library: options.library,
            },
            count: partners.length,
            partners,
          }

          if (options.json) {
            printJson(payload)
            return
          }

          for (const partner of partners) {
            console.log(
              `${chalk.bold(partner.name)} [${partner.category}] - ${partner.description}\n${chalk.blue(partner.url)}`,
            )
          }
        } catch (error) {
          log.error(error instanceof Error ? error.message : String(error))
          process.exit(1)
        }
      },
    )

  // === PIN-VERSIONS SUBCOMMAND ===
  program
    .command('pin-versions')
    .description('Pin versions of the TanStack libraries')
    .action(async () => {
      if (!fs.existsSync('package.json')) {
        console.error('package.json not found')
        return
      }
      const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))

      const packages: Record<string, string> = {
        '@tanstack/react-router': '',
        '@tanstack/router-generator': '',
        '@tanstack/react-router-devtools': '',
        '@tanstack/react-start': '',
        '@tanstack/react-start-config': '',
        '@tanstack/router-plugin': '',
        '@tanstack/react-start-client': '',
        '@tanstack/react-start-plugin': '1.115.0',
        '@tanstack/react-start-server': '',
        '@tanstack/start-server-core': '1.115.0',
      }

      function sortObject(obj: Record<string, string>): Record<string, string> {
        return Object.keys(obj)
          .sort()
          .reduce<Record<string, string>>((acc, key) => {
            acc[key] = obj[key]
            return acc
          }, {})
      }

      if (!packageJson.dependencies['@tanstack/react-start']) {
        console.error('@tanstack/react-start not found in dependencies')
        return
      }
      let changed = 0
      const startVersion = packageJson.dependencies[
        '@tanstack/react-start'
      ].replace(/^\^/, '')
      for (const pkg of Object.keys(packages)) {
        if (!packageJson.dependencies[pkg]) {
          packageJson.dependencies[pkg] = packages[pkg].length
            ? semver.maxSatisfying(
                [startVersion, packages[pkg]],
                `^${packages[pkg]}`,
              )!
            : startVersion
          changed++
        } else {
          if (packageJson.dependencies[pkg].startsWith('^')) {
            packageJson.dependencies[pkg] = packageJson.dependencies[
              pkg
            ].replace(/^\^/, '')
            changed++
          }
        }
      }
      packageJson.dependencies = sortObject(packageJson.dependencies)
      if (changed > 0) {
        fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2))
        console.log(
          `${changed} packages updated.

Remove your node_modules directory and package lock file and re-install.`,
        )
      } else {
        console.log(
          'No changes needed. The relevant TanStack packages are already pinned.',
        )
      }
    })

  // === ADD SUBCOMMAND ===
  program
    .command('add')
    .argument(
      '[add-on...]',
      'Name of the add-ons (or add-ons separated by spaces or commas)',
    )
    .option('--forced', 'Force the add-on to be added', false)
    .action(async (addOns: Array<string>, options: { forced: boolean }) => {
      const parsedAddOns: Array<string> = []
      for (const addOn of addOns) {
        if (addOn.includes(',') || addOn.includes(' ')) {
          parsedAddOns.push(
            ...addOn.split(/[\s,]+/).map((addon) => addon.trim()),
          )
        } else {
          parsedAddOns.push(addOn.trim())
        }
      }
      if (parsedAddOns.length < 1) {
        const selectedAddOns = await promptForAddOns()
        if (selectedAddOns.length) {
          await addToApp(environment, selectedAddOns, resolve(process.cwd()), {
            forced: options.forced,
          })
        }
      } else {
        await addToApp(environment, parsedAddOns, resolve(process.cwd()), {
          forced: options.forced,
        })
      }
    })

  // === ADD-ON SUBCOMMAND ===
  const addOnCommand = program.command('add-on')
  addOnCommand
    .command('init')
    .description('Initialize an add-on from the current project')
    .action(async () => {
      await initAddOn(environment)
    })
  addOnCommand
    .command('compile')
    .description('Update add-on from the current project')
    .action(async () => {
      await compileAddOn(environment)
    })
  addOnCommand
    .command('dev')
    .description(
      'Watch project files and continuously refresh .add-on and add-on.json',
    )
    .action(async () => {
      await devAddOn(environment)
    })

  // === TEMPLATE SUBCOMMAND ===
  const templateCommand = program.command('template')
  templateCommand
    .command('init')
    .description('Initialize a project template from the current project')
    .action(async () => {
      await initStarter(environment)
    })
  templateCommand
    .command('compile')
    .description('Compile the template JSON file for the current project')
    .action(async () => {
      await compileStarter(environment)
    })

  // Legacy alias for template command
  const starterCommand = program.command('starter')
  starterCommand
    .command('init')
    .description('Deprecated alias: initialize a project template')
    .action(async () => {
      await initStarter(environment)
    })
  starterCommand
    .command('compile')
    .description('Deprecated alias: compile the template JSON file')
    .action(async () => {
      await compileStarter(environment)
    })

  // === LEGACY AUTO-CREATE MODE ===
  // For backward compatibility with cli-aliases (create-tsrouter-app, etc.)
  // If legacyAutoCreate is true and no subcommand is provided, treat the first
  // argument as a project name and auto-invoke create behavior
  if (legacyAutoCreate) {
    // Configure the main program with create options for legacy mode
    configureCreateCommand(program)
    program.action(handleCreate)
  }

  program.parse()
}
