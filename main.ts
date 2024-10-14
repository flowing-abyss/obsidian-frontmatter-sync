import { App, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { parse as parseYaml } from "yaml";

interface FrontmatterSyncSettings {
	syncTags: string[];
	ignoreTags: string[];
}

const DEFAULT_SETTINGS: FrontmatterSyncSettings = {
	syncTags: [],
	ignoreTags: [],
};

export default class FrontmatterSyncPlugin extends Plugin {
	settings: FrontmatterSyncSettings;
	private timeout: NodeJS.Timeout | null = null;

	async onload() {
		await this.loadSettings();

		this.registerEvent(
			this.app.vault.on("modify", (file: TFile) => {
				if (file.extension === "md") {
					this.debounceSyncFrontmatter(file);
				}
			})
		);

		this.addSettingTab(new FrontmatterSyncSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	debounceSyncFrontmatter(file: TFile) {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		this.timeout = setTimeout(() => {
			this.syncFrontmatter(file);
		}, 2000);
	}

	async syncFrontmatter(file: TFile) {
		const content = await this.app.vault.read(file);
		const frontmatter = this.parseFrontmatter(content);

		if (!frontmatter) {
			return;
		}

		const updatedFrontmatter = this.synchronizeProperties(frontmatter);

		if (
			JSON.stringify(frontmatter) !== JSON.stringify(updatedFrontmatter)
		) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				Object.keys(updatedFrontmatter).forEach((key) => {
					fm[key] = updatedFrontmatter[key];
				});
				Object.keys(fm).forEach((key) => {
					if (!(key in updatedFrontmatter)) {
						delete fm[key];
					}
				});
			});
		}
	}

	parseFrontmatter(content: string): any {
		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
		if (fmMatch) {
			try {
				return parseYaml(fmMatch[1]);
			} catch (e) {
				return null;
			}
		}
		return null;
	}

	synchronizeProperties(frontmatter: any): any {
		const updatedFrontmatter = { ...frontmatter };
		let tags = new Set<string>(updatedFrontmatter.tags || []);

		const hasIgnoredTag = Array.from(tags).some((tag) =>
			this.settings.ignoreTags.some((ignoreTag) =>
				tag.startsWith(ignoreTag)
			)
		);
		if (hasIgnoredTag) {
			return updatedFrontmatter;
		}

		const hasRequiredTag = Array.from(tags).some((tag) =>
			this.settings.syncTags.some((syncTag) => tag.startsWith(syncTag))
		);

		if (!hasRequiredTag) {
			return updatedFrontmatter;
		}

		const hasCategoryProperty = "category" in updatedFrontmatter;

		const extractCategoryName = (cat: string): string => {
			if (!cat) return "";
			cat = cat.replace(/^\[\[|\]\]$/g, "");
			const parts = cat.split("/");
			let lastPart = parts[parts.length - 1];
			lastPart = lastPart.split("|")[0];
			lastPart = lastPart.replace(/\.md$/, "");
			return lastPart.trim();
		};

		const originalCategories = hasCategoryProperty
			? updatedFrontmatter.category
			: undefined;

		const categories = new Set<string>(
			Array.isArray(originalCategories)
				? originalCategories.map(extractCategoryName).filter(Boolean)
				: originalCategories
				? [extractCategoryName(originalCategories)]
				: []
		);

		if (categories.size > 0) {
			tags = new Set(
				Array.from(tags).filter((tag) => !tag.startsWith("category/"))
			);

			for (const category of categories) {
				const tagCategory = category.replace(/\s+/g, "_");
				tags.add(`category/${tagCategory}`);
			}
		} else {
			tags = new Set(
				Array.from(tags).filter((tag) => !tag.startsWith("category/"))
			);
		}

		if (tags.size > 0) {
			updatedFrontmatter.tags = Array.from(tags);
		} else {
			delete updatedFrontmatter.tags;
		}

		if (hasCategoryProperty) {
			updatedFrontmatter.category = originalCategories;
		}

		return updatedFrontmatter;
	}
}

class FrontmatterSyncSettingTab extends PluginSettingTab {
	plugin: FrontmatterSyncPlugin;
	private tagInput: HTMLInputElement;

	constructor(app: App, plugin: FrontmatterSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Frontmatter Sync" });

		new Setting(containerEl)
			.setName("Add Sync Tag")
			.setDesc("Enter a tag to add to the sync list")
			.addText((text) => {
				this.tagInput = text.inputEl;
				text.setPlaceholder("Enter tag");
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					const newTag = this.tagInput.value.trim();
					if (
						newTag &&
						!this.plugin.settings.syncTags.includes(newTag)
					) {
						this.plugin.settings.syncTags.push(newTag);
						await this.plugin.saveSettings();
						this.tagInput.value = "";
						this.display();
					}
				})
			);

		containerEl.createEl("h3", { text: "Current Sync Tags" });

		this.plugin.settings.syncTags.forEach((tag, index) => {
			new Setting(containerEl).setName(tag).addButton((button) =>
				button.setButtonText("Remove").onClick(async () => {
					this.plugin.settings.syncTags.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				})
			);
		});

		containerEl.createEl("h2", { text: "Ignore Tags" });

		new Setting(containerEl)
			.setName("Add Ignore Tag")
			.setDesc("Enter a tag to add to the ignore list")
			.addText((text) => {
				this.tagInput = text.inputEl;
				text.setPlaceholder("Enter tag");
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					const newTag = this.tagInput.value.trim();
					if (
						newTag &&
						!this.plugin.settings.ignoreTags.includes(newTag)
					) {
						this.plugin.settings.ignoreTags.push(newTag);
						await this.plugin.saveSettings();
						this.tagInput.value = "";
						this.display();
					}
				})
			);

		containerEl.createEl("h3", { text: "Current Ignore Tags" });

		this.plugin.settings.ignoreTags.forEach((tag, index) => {
			new Setting(containerEl).setName(tag).addButton((button) =>
				button.setButtonText("Remove").onClick(async () => {
					this.plugin.settings.ignoreTags.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				})
			);
		});
	}
}
