/**Indepth analyzer */
export async function indepth({login, data, imports, repositories}, {skipped}) {
  //Check prerequisites
  if (!await imports.which("github-linguist"))
    throw new Error("Feature requires github-linguist")

  //Compute repositories stats from fetched repositories
  const results = {total:0, lines:{}, stats:{}}
  for (const repository of repositories) {
    //Skip repository if asked
    if ((skipped.includes(repository.name.toLocaleLowerCase())) || (skipped.includes(`${repository.owner.login}/${repository.name}`.toLocaleLowerCase()))) {
      console.debug(`metrics/compute/${login}/plugins > languages > skipped repository ${repository.owner.login}/${repository.name}`)
      continue
    }

    //Repository handle
    const repo = `${repository.owner.login}/${repository.name}`
    console.debug(`metrics/compute/${login}/plugins > languages > indepth > checking ${repo}`)

    //Temporary directory
    const path = imports.paths.join(imports.os.tmpdir(), `${data.user.databaseId}-${repo.replace(/[^\w]/g, "_")}`)
    console.debug(`metrics/compute/${login}/plugins > languages > indepth > cloning ${repo} to temp dir ${path}`)

    //Process
    try {
      //Git clone into temporary directory
      await imports.fs.rmdir(path, {recursive:true})
      await imports.fs.mkdir(path, {recursive:true})
      const git = await imports.git(path)
      await git.clone(`https://github.com/${repo}`, ".").status()

      //Analyze repository
      await analyze(arguments[0], {results, path})
    }
    catch {
      console.debug(`metrics/compute/${login}/plugins > languages > indepth > an error occured while processing ${repo}, skipping...`)
    }
    finally {
      //Cleaning
      console.debug(`metrics/compute/${login}/plugins > languages > indepth > cleaning temp dir ${path}`)
      await imports.fs.rmdir(path, {recursive:true})
    }
  }
  return results
}

/**Recent languages activity */
export async function recent({login, data, imports, rest, account}, {skipped}) {
  //Check prerequisites
  if (!await imports.which("github-linguist"))
    throw new Error("Feature requires github-linguist")

  //Get user recent activity
  console.debug(`metrics/compute/${login}/plugins > languages > querying api`)
  const commits = [], days = 14, pages = 3, results = {total:0, lines:{}, stats:{}}
  try {
    for (let page = 1; page <= pages; page++) {
      console.debug(`metrics/compute/${login}/plugins > languages > loading page ${page}`)
      commits.push(...(await rest.activity.listEventsForAuthenticatedUser({username:login, per_page:100, page})).data
        .filter(({type}) => type === "PushEvent")
        .filter(({actor}) => account === "organization" ? true : actor.login === login)
        .filter(({repo:{name:repo}}) => (!skipped.includes(repo.toLocaleLowerCase())) && (!skipped.includes(repo.toLocaleLowerCase().split("/").pop())))
        .filter(({created_at}) => new Date(created_at) > new Date(Date.now() - days * 24 * 60 * 60 * 1000))
      )
    }
  }
  catch {
    console.debug(`metrics/compute/${login}/plugins > languages > no more page to load`)
  }
  console.debug(`metrics/compute/${login}/plugins > languages > ${commits.length} commits loaded`)

  //Retrieve edited files and filter edited lines (those starting with +/-) from patches
  console.debug(`metrics/compute/${login}/plugins > languages > loading patches`)
  const patches = [
    ...await Promise.allSettled(
      commits
        .flatMap(({payload}) => payload.commits).map(commit => commit.url)
        .map(async commit => (await rest.request(commit)).data.files),
    ),
  ]
  .filter(({status}) => status === "fulfilled")
  .map(({value}) => value)
  .flatMap(files => files.map(file => ({name:imports.paths.basename(file.filename), patch:file.patch ?? ""})))
  .map(({name, patch}) => ({name, patch:patch.split("\n").filter(line => /^[+]/.test(line)).map(line => line.substring(1)).join("\n")}))

  //Temporary directory
  const path = imports.paths.join(imports.os.tmpdir(), `${data.user.databaseId}`)
  console.debug(`metrics/compute/${login}/plugins > languages > creating temp dir ${path} with ${patches.length} files`)

  //Process
  try {
    //Save patches in temporary directory
    await imports.fs.rmdir(path, {recursive:true})
    await imports.fs.mkdir(path, {recursive:true})
    await Promise.all(patches.map(({name, patch}, i) => imports.fs.writeFile(imports.paths.join(path, `${i}${imports.paths.extname(name)}`), patch)))

    //Create temporary git repository
    console.debug(`metrics/compute/${login}/plugins > languages > creating temp git repository`)
    const git = await imports.git(path)
    await git.init().add(".").addConfig("user.name", login).addConfig("user.email", "<>").commit("linguist").status()

    //Analyze repository
    await analyze(arguments[0], {results, path})
  }
  catch {
    console.debug(`metrics/compute/${login}/plugins > languages > an error occured while processing recently used languages`)
  }
  finally {
    //Cleaning
    console.debug(`metrics/compute/${login}/plugins > languages > cleaning temp dir ${path}`)
    await imports.fs.rmdir(path, {recursive:true})
  }
  return results
}

/**Analyze a single repository */
async function analyze({login, imports}, {results, path}) {
  //Spawn linguist process and map files to languages
  console.debug(`metrics/compute/${login}/plugins > languages > indepth > running linguist`)
  const files = Object.fromEntries(Object.entries(JSON.parse(await imports.run("github-linguist --json", {cwd:path}, {log:false}))).flatMap(([lang, files]) => files.map(file => [file, lang])))

  //Processing diff
  const per_page = 10
  console.debug(`metrics/compute/${login}/plugins > languages > indepth > checking git log`)
  for (let page = 0; ; page++) {
    try {
      const stdout = await imports.run(`git log --author="${login}" --format="" --patch --max-count=${per_page} --skip=${page*per_page}`, {cwd:path}, {log:false})
      let file = null, lang = null
      if (!stdout.trim().length) {
        console.debug(`metrics/compute/${login}/plugins > languages > indepth > no more commits`)
        break
      }
      console.debug(`metrics/compute/${login}/plugins > languages > indepth > processing commits ${page*per_page} from ${(page+1)*per_page}`)
      for (const line of stdout.split("\n").map(line => line.trim())) {
        //Ignore empty lines or unneeded lines
        if ((!/^[+]/.test(line))||(!line.length))
          continue
        //File marker
        if (/^[+]{3}\sb[/](?<file>[\s\S]+)$/.test(line)) {
          file = line.match(/^[+]{3}\sb[/](?<file>[\s\S]+)$/)?.groups?.file ?? null
          lang = files[file] ?? null
          continue
        }
        //Ignore unkonwn languages
        if (!lang)
          continue
        //Added line marker
        if (/^[+]\s*(?<line>[\s\S]+)$/.test(line)) {
          const size = Buffer.byteLength(line.match(/^[+]\s*(?<line>[\s\S]+)$/)?.groups?.line ?? "", "utf-8")
          results.stats[lang] = (results.stats[lang] ?? 0) + size
          results.lines[lang] = (results.lines[lang] ?? 0) + 1
          results.total += size
        }
      }
    }
    catch {
      console.debug(`metrics/compute/${login}/plugins > languages > indepth > an error occured on page ${page}, skipping...`)
    }
  }

}