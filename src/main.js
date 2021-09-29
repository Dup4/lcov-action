const artifact = require('@actions/artifact');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const glob = require('@actions/glob');
const lcovTotal = require("lcov-total");
const os = require('os');
const path = require('path');

async function run() {
	try {
		await exec.exec('sudo apt-get install -y lcov');

		const tmpPath = path.resolve(os.tmpdir(), github.context.action);
		const coverageFilesPattern = core.getInput('coverage-files');
		const globber = await glob.create(coverageFilesPattern);
		const coverageFiles = await globber.glob();

		await genhtml(coverageFiles, tmpPath);

		const coverageFile = await mergeCoverages(coverageFiles, tmpPath);
		const totalCoverage = lcovTotal(coverageFile);
		const minimumCoverage = core.getInput('minimum-coverage');
		const gitHubToken = core.getInput('github-token').trim();
		const errorMessage = `The code coverage is too low. Expected at least ${minimumCoverage}.`;
		const isFailure = totalCoverage < parseInt(minimumCoverage);

		if (gitHubToken !== '' && github.context.eventName === 'pull_request') {
			const octokit = github.getOctokit(gitHubToken);
			const sha = github.context.payload.pull_request.head.sha;
			const shaShort = sha.substr(0, 7);

			const summary = await summarize(coverageFile);
			const details = await detail(coverageFile, octokit);

			let body = 
`# [LCOV](https://github.com/Dup4/lcov-action) Report

---

> commit [<code>${shaShort}</code>](${github.context.payload.pull_request.number}/commits/${sha}) during [${github.context.workflow} #${github.context.runNumber}](../actions/runs/${github.context.runId})

<pre>

${summary}

Files changed coverage rate:${details}

</pre>
`;

			if (isFailure) {
				body += `\n:no_entry: ${errorMessage}`;
			}

			await octokit.issues.createComment({
				owner: github.context.repo.owner,
				repo: github.context.repo.repo,
				issue_number: github.context.payload.pull_request.number,
				body: body,
			});
		}

		if (isFailure) {
			throw Error(errorMessage);
		}
	} catch (error) {
		core.setFailed(error.message);
	}
}

async function genhtml(coverageFiles, tmpPath) {
	const workingDirectory = core.getInput('working-directory').trim() || './';
	const artifactName = core.getInput('artifact-name').trim();
	const artifactPath = path.resolve(tmpPath, 'html').trim();
	const args = [...coverageFiles];

	args.push('--output-directory');
	args.push(artifactPath);

	const branchCoverage = core.getInput('branch-coverage').trim();
	if (branchCoverage === 'true') {
		args.push('--rc');
		args.push('genhtml_branch_coverage=1');
	}

	await exec.exec('genhtml', args, { cwd: workingDirectory });

	const globber = await glob.create(`${artifactPath}/**`);
	const htmlFiles = await globber.glob();

	await artifact
		.create()
		.uploadArtifact(
			artifactName,
			htmlFiles,
			artifactPath,
			{ continueOnError: false },
		);
}

async function mergeCoverages(coverageFiles, tmpPath) {
	// This is broken for some reason:
	// const mergedCoverageFile = path.resolve(tmpPath, 'lcov.info');
	const mergedCoverageFile = tmpPath + '/lcov.info';
	const args = [];

	for (const coverageFile of coverageFiles) {
		args.push('--add-tracefile');
		args.push(coverageFile);
	}

	const branchCoverage = core.getInput('branch-coverage').trim();
	if (branchCoverage === 'true') {
		args.push('--rc');
		args.push('lcov_branch_coverage=1');
	}

	args.push('--output-file');
	args.push(mergedCoverageFile);

	await exec.exec('lcov', args);

	return mergedCoverageFile;
}

async function summarize(coverageFile) {
	let output = '';
	const args = [];

	const options = {};
	options.listeners = {
		stdout: (data) => {
			output += data.toString();
		},
		stderr: (data) => {
			output += data.toString();
		}
	};

	args.push('--summary');

	const branchCoverage = core.getInput('branch-coverage').trim();
	if (branchCoverage === 'true') {
		args.push('--rc');
		args.push('lcov_branch_coverage=1');
	}

	args.push(coverageFile);

	await exec.exec('lcov', args, options);

	const lines = output
		.trim()
		.split(/\r?\n/);

	lines.shift(); // Removes "Reading tracefile..."

	return lines.join('\n');
}

async function detail(coverageFile, octokit) {
	let output = '';
	const args = [];

	const options = {};
	options.listeners = {
		stdout: (data) => {
			output += data.toString();
		},
		stderr: (data) => {
			output += data.toString();
		}
	};

	args.push('--list');

	const branchCoverage = core.getInput('branch-coverage').trim();
	if (branchCoverage === 'true') {
		args.push('--rc');
		args.push('lcov_branch_coverage=1');
	}

	args.push(coverageFile);

	await exec.exec('lcov', args, options);

	let lines = output
		.trim()
		.split(/\r?\n/);

	// Removes "Reading tracefile..."
	lines.shift(); 

	const listFilesOptions = octokit
		.pulls.listFiles.endpoint.merge({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			pull_number: github.context.payload.pull_request.number,
		});

	const listFilesResponse = await octokit.paginate(listFilesOptions);
	const changedFiles = listFilesResponse.map(file => file.filename);

	lines = lines.filter((line, index) => {
		// Include header
		if (index <= 2) return true;

		for (const changedFile of changedFiles) {
			console.log(`${line} === ${changedFile}`);
			console.log(`${line.trim().split('|')[0].trim()}`);

			if (line.trim().split('|')[0].trim().endsWith(changedFile)) {
				return true;
			}
		}

		return false;
	});

	// Only the header remains
	if (lines.length === 3) { 
		return ' n/a';
	}

	return '\n' + lines.join('\n');
}

run();
