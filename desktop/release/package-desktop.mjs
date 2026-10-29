// Public release assembly; application code is always loaded from the frozen checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function owned(root, file) {
    const resolved = realpathSync(file);
    if (!resolved.startsWith(root + sep) || (process.getuid && statSync(resolved).uid !== process.getuid())) throw new Error("Canvas package must remain inside owned dependencies.");
    return resolved;
}

/** Restore complete, installed, lock-matched canvas packages omitted by standalone tracing. */
export function stageCanvas(projectDir, platform, arches) {
    const root = realpathSync(projectDir), dependencies = realpathSync(join(root, "node_modules"));
    if (dependencies !== join(root, "node_modules")) throw new Error("Release dependencies must be physical and owned.");
    const standalone = realpathSync(join(root, ".next", "standalone"));
    if (standalone !== join(root, ".next", "standalone")) throw new Error("Standalone must remain inside the frozen checkout.");
    const projectRequire = createRequire(join(root, "package.json"));
    const pdfRequire = createRequire(owned(dependencies, projectRequire.resolve("pdfjs-dist/package.json")));
    const canvasFile = owned(dependencies, pdfRequire.resolve("@napi-rs/canvas/package.json"));
    const canvas = JSON.parse(readFileSync(canvasFile, "utf8")), canvasRequire = createRequire(canvasFile);
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const suffix = platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
    const names = ["@napi-rs/canvas", ...arches.map(arch => `@napi-rs/canvas-${platform}-${arch}${suffix}`)];
    const packages = names.map(name => {
        const file = owned(dependencies, canvasRequire.resolve(`${name}/package.json`));
        const metadata = JSON.parse(readFileSync(file, "utf8"));
        if (metadata.name !== name || metadata.version !== canvas.version || !lock.includes(`  '${name}@${metadata.version}':`)) throw new Error("Canvas package differs from the frozen lockfile.");
        if (name !== "@napi-rs/canvas") {
            const arch = arches[names.indexOf(name) - 1];
            if (canvas.optionalDependencies?.[name] !== metadata.version || !metadata.os?.includes(platform) || !metadata.cpu?.includes(arch) || platform === "linux" && !metadata.libc?.includes("glibc")) throw new Error("Canvas native package does not match the release target.");
            if (typeof metadata.main !== "string" || !metadata.main.endsWith(".node")) throw new Error("Canvas native package has no binding.");
            const binary = owned(dependencies, join(dirname(file), metadata.main));
            if (!statSync(binary).isFile() || statSync(binary).size === 0) throw new Error("Canvas native binding is empty or invalid.");
        }
        return { source: dirname(file), destination: join(standalone, "node_modules", name) };
    });
    for (const { source, destination } of packages) {
        mkdirSync(join(standalone, "node_modules"), { recursive: true });
        cpSync(source, destination, { recursive: true, dereference: true, filter(from, to) {
            owned(dependencies, from);
            for (let current = to; current !== standalone; current = dirname(current)) {
                const info = lstatSync(current, { throwIfNoEntry: false });
                if (info?.isSymbolicLink() || info && process.getuid && info.uid !== process.getuid()) throw new Error("Canvas destination must remain inside owned standalone files.");
            }
            return true;
        } });
    }
    const packagedRequire = createRequire(join(standalone, "package.json"));
    for (const name of names) {
        owned(standalone, packagedRequire.resolve(`${name}/package.json`));
    }
    return names;
}

/**
 * Build the frozen helper, speech executable and hash-pinned model sequentially.
 * @param {string} projectDir
 * @param {string} platform
 * @param {string[]} arches
 * @param {{prepare?: (args: string[], options: {platform: string, arch: string, run: (exe: string, args: string[]) => unknown}) => Promise<void>, run?: (exe: string, args: string[], options: object) => unknown}} [dependencies]
 */
export async function prepareResources(projectDir, platform, arches, { prepare, run = execFileSync } = {}) {
    const prepareResource = prepare ?? (await import(pathToFileURL(join(projectDir, "scripts", "prepare-meeting-native.mjs")).href)).prepare;
    for (const arch of arches) {
        for (const action of ["--helper", "--speech", "--model"]) {
            await prepareResource([action], { platform, arch, run(executable, argv) {
                const args = executable === "cmake" && argv[0] === "-S" && platform === "darwin" ? [...argv, `-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : "arm64"}`] : argv;
                return run(executable, args, { stdio: "inherit", timeout: 600_000 });
            } });
        }
    }
}

/**
 * @param {string[]} args
 * @param {{projectDir?: string, platform?: string, run?: (command: string, args: string[], options: object) => {status: number | null}}} [options]
 */
export async function packageDesktop(args, { projectDir = process.cwd(), platform = process.platform, run = spawnSync } = {}) {
    const target = { "--mac": "darwin", "--win": "win32", "--linux": "linux" }[args[0]];
    const arches = args.slice(1).map(flag => flag.slice(2));
    if (target !== platform || !arches.length || new Set(arches).size !== arches.length || args.slice(1).some(flag => !["--arm64", "--x64"].includes(flag)) || platform !== "darwin" && (arches.length !== 1 || arches[0] !== "x64")) throw new Error("Use the native release matrix target and explicit supported architectures.");
    const projectRequire = createRequire(join(projectDir, "package.json"));
    const builder = projectRequire.resolve("electron-builder/cli.js");
    await prepareResources(projectDir, platform, arches);
    const { runPackage } = await import(pathToFileURL(join(projectDir, "scripts", "desktop-package.mjs")).href);
    runPackage(args, { run(command, commandArgs, options) {
        if (commandArgs[0] === builder) {
            stageCanvas(projectDir, platform, arches);
            const smoke = run(process.execPath, ["-e", "require('@napi-rs/canvas').createCanvas(1, 1)"], { ...options, cwd: join(projectDir, ".next", "standalone") });
            if (smoke.status !== 0) throw new Error("Staged canvas failed its native runtime check.");
            if (platform === "linux") {
                const depends = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")).build?.deb?.depends;
                if (!Array.isArray(depends) || !depends.length || depends.some(value => typeof value !== "string" || !value.trim())) throw new Error("Frozen Debian dependencies must be a nonempty string array.");
                commandArgs = [...commandArgs, ...[...depends, "libpipewire-0.3-0 (>= 0.3.65)"].map(value => `--config.deb.depends=${value}`)];
            }
        }
        return run(command, commandArgs, options);
    } });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try { await packageDesktop(process.argv.slice(2)); }
    catch (error) { console.error(`Desktop release assembly failed: ${error.message}`); process.exitCode = 1; }
}
