import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "node:child_process";
import * as path from "node:path";

// Helper to run git commands in a specific repository path
function runGit(repoPath: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		// Escape arguments to protect against shell injection
		const escapedArgs = args.map(arg => {
			if (process.platform === "win32") {
				// Escape double quotes and wrap in double quotes for cmd.exe
				return `"${arg.replace(/"/g, '""')}"`;
			} else {
				// Escape single quotes for bash
				return `'${arg.replace(/'/g, "'\\''")}'`;
			}
		});
		
		const command = `git ${escapedArgs.join(" ")}`;
		exec(command, { cwd: repoPath }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || stdout.trim() || error.message));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

export default function gitMcpExtension(pi: ExtensionAPI) {
	
	// 1. git_status
	pi.registerTool({
		name: "git_status",
		label: "Git Status",
		description: "Shows the working tree status",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" })
		}),
		async execute(toolCallId, params) {
			try {
				const output = await runGit(params.repo_path, ["status"]);
				return { content: [{ type: "text", text: output || "Working tree clean" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 2. git_diff_unstaged
	pi.registerTool({
		name: "git_diff_unstaged",
		label: "Git Diff Unstaged",
		description: "Shows changes in working directory not yet staged",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			context_lines: Type.Optional(Type.Number({ description: "Number of context lines to show (default: 3)" }))
		}),
		async execute(toolCallId, params) {
			try {
				const context = params.context_lines !== undefined ? params.context_lines : 3;
				const output = await runGit(params.repo_path, ["diff", `-U${context}`]);
				return { content: [{ type: "text", text: output || "No unstaged changes" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 3. git_diff_staged
	pi.registerTool({
		name: "git_diff_staged",
		label: "Git Diff Staged",
		description: "Shows changes that are staged for commit",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			context_lines: Type.Optional(Type.Number({ description: "Number of context lines to show (default: 3)" }))
		}),
		async execute(toolCallId, params) {
			try {
				const context = params.context_lines !== undefined ? params.context_lines : 3;
				const output = await runGit(params.repo_path, ["diff", "--cached", `-U${context}`]);
				return { content: [{ type: "text", text: output || "No staged changes" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 4. git_diff
	pi.registerTool({
		name: "git_diff",
		label: "Git Diff",
		description: "Shows differences between branches or commits",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			target: Type.String({ description: "Target branch or commit to compare with" }),
			context_lines: Type.Optional(Type.Number({ description: "Number of context lines to show (default: 3)" }))
		}),
		async execute(toolCallId, params) {
			try {
				const context = params.context_lines !== undefined ? params.context_lines : 3;
				const output = await runGit(params.repo_path, ["diff", params.target, `-U${context}`]);
				return { content: [{ type: "text", text: output || "No differences" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 5. git_add
	pi.registerTool({
		name: "git_add",
		label: "Git Add",
		description: "Adds file contents to the staging area",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			files: Type.Array(Type.String(), { description: "Array of file paths to stage" })
		}),
		async execute(toolCallId, params) {
			try {
				// Defense-in-depth: resolve and verify the staging paths are inside repo_path boundaries
				const resolvedRepo = path.resolve(params.repo_path);
				for (const file of params.files) {
					const resolvedFile = path.resolve(params.repo_path, file);
					if (!resolvedFile.startsWith(resolvedRepo)) {
						return { 
							content: [{ type: "text", text: `Error: Path traversal blocked. File '${file}' is outside the repository directory.` }], 
							isError: true 
						};
					}
				}

				await runGit(params.repo_path, ["add", ...params.files]);
				return { content: [{ type: "text", text: `Successfully staged: ${params.files.join(", ")}` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 6. git_commit
	pi.registerTool({
		name: "git_commit",
		label: "Git Commit",
		description: "Records changes to the repository",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			message: Type.String({ description: "Commit message" })
		}),
		async execute(toolCallId, params) {
			try {
				const output = await runGit(params.repo_path, ["commit", "-m", params.message]);
				return { content: [{ type: "text", text: output }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 7. git_reset
	pi.registerTool({
		name: "git_reset",
		label: "Git Reset",
		description: "Unstages all staged changes",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" })
		}),
		async execute(toolCallId, params) {
			try {
				await runGit(params.repo_path, ["reset"]);
				return { content: [{ type: "text", text: "Successfully unstaged all changes" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 8. git_log
	pi.registerTool({
		name: "git_log",
		label: "Git Log",
		description: "Shows the commit logs with optional date filtering",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			max_count: Type.Optional(Type.Number({ description: "Maximum number of commits to show (default: 10)" })),
			start_timestamp: Type.Optional(Type.String({ description: "ISO 8601, relative (e.g. '2 weeks ago'), or absolute date" })),
			end_timestamp: Type.Optional(Type.String({ description: "ISO 8601, relative, or absolute date" }))
		}),
		async execute(toolCallId, params) {
			try {
				const args = ["log", `--max-count=${params.max_count || 10}`, "--oneline"];
				if (params.start_timestamp) {
					args.push(`--since=${params.start_timestamp}`);
				}
				if (params.end_timestamp) {
					args.push(`--until=${params.end_timestamp}`);
				}
				const output = await runGit(params.repo_path, args);
				return { content: [{ type: "text", text: output || "No commits match criteria" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 9. git_create_branch
	pi.registerTool({
		name: "git_create_branch",
		label: "Git Create Branch",
		description: "Creates a new branch",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			branch_name: Type.String({ description: "Name of the new branch" }),
			base_branch: Type.Optional(Type.String({ description: "Base branch to create from" }))
		}),
		async execute(toolCallId, params) {
			try {
				const args = ["checkout", "-b", params.branch_name];
				if (params.base_branch) {
					args.push(params.base_branch);
				}
				const output = await runGit(params.repo_path, args);
				return { content: [{ type: "text", text: output || `Created and checked out branch '${params.branch_name}'` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 10. git_checkout
	pi.registerTool({
		name: "git_checkout",
		label: "Git Checkout",
		description: "Switches branches",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			branch_name: Type.String({ description: "Name of branch to checkout" })
		}),
		async execute(toolCallId, params) {
			try {
				const output = await runGit(params.repo_path, ["checkout", params.branch_name]);
				return { content: [{ type: "text", text: output || `Switched to branch '${params.branch_name}'` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 11. git_show
	pi.registerTool({
		name: "git_show",
		label: "Git Show",
		description: "Shows the contents of a commit",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			revision: Type.String({ description: "The revision (commit hash, branch name, tag) to show" })
		}),
		async execute(toolCallId, params) {
			try {
				const output = await runGit(params.repo_path, ["show", params.revision]);
				return { content: [{ type: "text", text: output }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});

	// 12. git_branch
	pi.registerTool({
		name: "git_branch",
		label: "Git Branch",
		description: "Lists Git branches",
		parameters: Type.Object({
			repo_path: Type.String({ description: "Path to Git repository" }),
			branch_type: Type.String({ description: "List 'local', 'remote', or 'all' branches" }),
			contains: Type.Optional(Type.String({ description: "The commit SHA that branch should contain" })),
			not_contains: Type.Optional(Type.String({ description: "The commit SHA that branch should NOT contain" }))
		}),
		async execute(toolCallId, params) {
			try {
				const args = ["branch"];
				if (params.branch_type === "all") {
					args.push("-a");
				} else if (params.branch_type === "remote") {
					args.push("-r");
				}
				if (params.contains) {
					args.push(`--contains=${params.contains}`);
				}
				if (params.not_contains) {
					args.push(`--no-contains=${params.not_contains}`);
				}
				const output = await runGit(params.repo_path, args);
				return { content: [{ type: "text", text: output || "No branches found" }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		}
	});
}
