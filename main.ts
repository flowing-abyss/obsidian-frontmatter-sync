import { App, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { parse as parseYaml } from "yaml";

interface ValueMapping {
	propertyValue: string;
	tagValue: string;
}

interface PropertySyncConfig {
	propertyName: string;
	syncType: "value" | "wikilink" | "direct";
	valueMappings?: ValueMapping[];
	tagPrefix?: string;
}

interface FrontmatterSyncSettings {
	propertyConfigs: PropertySyncConfig[];
	syncTags: string[]; // Global tags that trigger sync
	ignoreTags: string[]; // Global tags that prevent sync
}

const DEFAULT_SETTINGS: FrontmatterSyncSettings = {
	propertyConfigs: [],
	syncTags: [],
	ignoreTags: [],
};

// Helper function to sanitize tag values
function sanitizeTagValue(value: any): string {
	// Convert any value to string first
	const stringValue = String(value);
	// Split by forward slash to preserve hierarchy
	return stringValue
		.split("/")
		.map((part) => part.replace(/[^a-zA-Z0-9_]/g, "_"))
		.join("/");
}

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

		// Check for ignore tags
		const hasIgnoredTag = Array.from(tags).some((tag) =>
			this.settings.ignoreTags.some((ignoreTag) =>
				tag.startsWith(ignoreTag)
			)
		);
		if (hasIgnoredTag) {
			return updatedFrontmatter;
		}

		// Check for sync tags
		const hasSyncTag = Array.from(tags).some((tag) =>
			this.settings.syncTags.some((syncTag) => tag.startsWith(syncTag))
		);
		if (!hasSyncTag) {
			return updatedFrontmatter;
		}

		// Process each property configuration
		for (const config of this.settings.propertyConfigs) {
			const propertyValue = updatedFrontmatter[config.propertyName];
			if (!propertyValue) continue;

			// Remove existing tags for this property
			if (config.syncType === "wikilink") {
				tags = new Set(
					Array.from(tags).filter(
						(tag) => !tag.startsWith(config.tagPrefix || "")
					)
				);
			} else if (config.syncType === "value") {
				tags = new Set(
					Array.from(tags).filter(
						(tag) =>
							!config.valueMappings?.some(
								(mapping) =>
									tag === sanitizeTagValue(mapping.tagValue)
							)
					)
				);
			} else if (config.syncType === "direct") {
				const values = Array.isArray(propertyValue)
					? propertyValue
					: [propertyValue];
				for (const value of values) {
					if (value !== null && value !== undefined) {
						tags.add(sanitizeTagValue(value));
					}
				}
			}

			// Add new tags based on sync type
			if (config.syncType === "wikilink") {
				const extractName = (value: string): string => {
					if (!value) return "";
					value = value.replace(/^\[\[|\]\]$/g, "");
					const parts = value.split("/");
					let lastPart = parts[parts.length - 1];
					lastPart = lastPart.split("|")[0];
					lastPart = lastPart.replace(/\.md$/, "");
					return lastPart.trim();
				};

				const values = Array.isArray(propertyValue)
					? propertyValue.map(extractName).filter(Boolean)
					: [extractName(propertyValue)].filter(Boolean);

				for (const value of values) {
					const tagValue = sanitizeTagValue(value);
					tags.add(`${config.tagPrefix || ""}${tagValue}`);
				}
			} else if (config.syncType === "value" && config.valueMappings) {
				const values = Array.isArray(propertyValue)
					? propertyValue
					: [propertyValue];
				for (const value of values) {
					const mapping = config.valueMappings.find(
						(m) => m.propertyValue === value
					);
					if (mapping) {
						tags.add(sanitizeTagValue(mapping.tagValue));
					}
				}
			}
		}

		if (tags.size > 0) {
			updatedFrontmatter.tags = Array.from(tags).sort((a, b) =>
				b.localeCompare(a)
			);
		} else {
			delete updatedFrontmatter.tags;
		}

		return updatedFrontmatter;
	}
}

class FrontmatterSyncSettingTab extends PluginSettingTab {
	plugin: FrontmatterSyncPlugin;
	private propertyInput: HTMLInputElement;
	private syncTypeSelect: HTMLSelectElement;
	private tagPrefixInput: HTMLInputElement;
	private propertyValueInput: HTMLInputElement;
	private tagValueInput: HTMLInputElement;
	private ignoreTagInput: HTMLInputElement;
	private syncTagInput: HTMLInputElement;

	constructor(app: App, plugin: FrontmatterSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Frontmatter Sync" });

		// Property Configurations section
		containerEl.createEl("h2", { text: "Property Configurations" });

		// Add new property configuration
		new Setting(containerEl)
			.setName("Add Property Configuration")
			.setDesc("Configure a new property to sync with tags")
			.addText((text) => {
				this.propertyInput = text.inputEl;
				text.setPlaceholder("Property name");
			})
			.addDropdown((dropdown) => {
				this.syncTypeSelect = dropdown.selectEl;
				dropdown
					.addOption("value", "Value Mapping")
					.addOption("wikilink", "Wiki Link")
					.addOption("direct", "Direct Sync")
					.onChange(() => this.updateInputVisibility());
			})
			.addText((text) => {
				this.tagPrefixInput = text.inputEl;
				text.setPlaceholder("Tag prefix (for wiki links)");
				text.inputEl.style.display = "none";
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					const propertyName = this.propertyInput.value.trim();
					const syncType = this.syncTypeSelect.value as
						| "value"
						| "wikilink"
						| "direct";

					if (!propertyName) return;

					const config: PropertySyncConfig = {
						propertyName,
						syncType,
						valueMappings: syncType === "value" ? [] : undefined,
						tagPrefix:
							syncType === "wikilink"
								? this.tagPrefixInput.value.trim()
								: undefined,
					};

					this.plugin.settings.propertyConfigs.push(config);
					await this.plugin.saveSettings();
					this.propertyInput.value = "";
					this.tagPrefixInput.value = "";
					this.display();
				})
			);

		// Display current configurations
		this.plugin.settings.propertyConfigs.forEach((config, index) => {
			const configContainer = containerEl.createDiv(
				"property-config-container"
			);
			const setting = new Setting(configContainer)
				.setName(config.propertyName)
				.setDesc(`Sync Type: ${config.syncType}`);

			if (config.syncType === "value") {
				// Add value mapping button
				setting.addButton((button) =>
					button.setButtonText("Add Mapping").onClick(() => {
						const mappingContainer =
							configContainer.createDiv("mapping-container");
						new Setting(mappingContainer)
							.setName("Value Mapping")
							.addText((text) => {
								this.propertyValueInput = text.inputEl;
								text.setPlaceholder("Property value");
							})
							.addText((text) => {
								this.tagValueInput = text.inputEl;
								text.setPlaceholder("Tag value");
							})
							.addButton((button) =>
								button
									.setButtonText("Add")
									.onClick(async () => {
										const propertyValue =
											this.propertyValueInput.value.trim();
										const tagValue =
											this.tagValueInput.value.trim();

										if (propertyValue && tagValue) {
											config.valueMappings?.push({
												propertyValue,
												tagValue,
											});
											await this.plugin.saveSettings();
											this.propertyValueInput.value = "";
											this.tagValueInput.value = "";
											this.display();
										}
									})
							);
					})
				);

				// Display existing mappings
				if (config.valueMappings?.length) {
					const mappingsContainer =
						configContainer.createDiv("mappings-container");
					config.valueMappings.forEach((mapping, mappingIndex) => {
						new Setting(mappingsContainer)
							.setName(
								`${mapping.propertyValue} → ${mapping.tagValue}`
							)
							.addButton((button) =>
								button
									.setButtonText("Remove")
									.onClick(async () => {
										config.valueMappings?.splice(
											mappingIndex,
											1
										);
										await this.plugin.saveSettings();
										this.display();
									})
							);
					});
				}
			} else if (config.syncType === "wikilink") {
				setting.setDesc(`Tag Prefix: ${config.tagPrefix || ""}`);
			}

			setting.addButton((button) =>
				button.setButtonText("Remove").onClick(async () => {
					this.plugin.settings.propertyConfigs.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				})
			);
		});

		// Sync Tags section
		containerEl.createEl("h2", { text: "Sync Tags" });
		new Setting(containerEl)
			.setName("Add Sync Tag")
			.setDesc(
				"Enter a tag prefix that will trigger synchronization (e.g., 'source' will match 'source/book')"
			)
			.addText((text) => {
				this.syncTagInput = text.inputEl;
				text.setPlaceholder("Enter tag prefix");
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					const newTag = this.syncTagInput.value.trim();
					if (
						newTag &&
						!this.plugin.settings.syncTags.includes(newTag)
					) {
						this.plugin.settings.syncTags.push(newTag);
						await this.plugin.saveSettings();
						this.syncTagInput.value = "";
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

		// Ignore tags section
		containerEl.createEl("h2", { text: "Ignore Tags" });

		new Setting(containerEl)
			.setName("Add Ignore Tag")
			.setDesc("Enter a tag to add to the ignore list")
			.addText((textInput) => {
				this.ignoreTagInput = textInput.inputEl;
				textInput.setPlaceholder("Enter tag");
			})
			.addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					const newTag = this.ignoreTagInput.value.trim();
					if (
						newTag &&
						!this.plugin.settings.ignoreTags.includes(newTag)
					) {
						this.plugin.settings.ignoreTags.push(newTag);
						await this.plugin.saveSettings();
						this.ignoreTagInput.value = "";
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

	private updateInputVisibility() {
		if (this.tagPrefixInput) {
			this.tagPrefixInput.style.display =
				this.syncTypeSelect.value === "wikilink" ? "block" : "none";
		}
	}
}
