import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownView,
	Editor,
	EditorRange,
	Menu,
	Notice,
	ItemView,
	WorkspaceLeaf,
	WorkspaceSplit,
} from "obsidian";

import {
	EditorView,
	WidgetType,
	Decoration,
	DecorationSet,
	ViewPlugin,
	ViewUpdate,
	MatchDecorator,
	gutter,
	GutterMarker,
} from "@codemirror/view";

import {
	EditorState,
	StateField,
	Annotation,
	StateEffect,
	Extension,
	RangeSetBuilder,
	Transaction,
	Text,
} from "@codemirror/state";

import { getSearchQuery, SearchQuery, SearchCursor } from "@codemirror/search";

/* State Fields */
type Link = {
	text: string;
	file: string;
	from: EditorRange;
	to: EditorRange;
};

let that = StateField.define<any>({
	create() {
		return null;
	},
	update(value, tr: any) {
		return tr["annotations"].length == 2 ? tr["annotations"][0].value : value;
	},
});

let links = StateField.define<Link[]>({
	create() {
		return [];
	},
	update(value, tr) {
		return [];
	},
});

let latestCopy = StateField.define<Link | null>({
	create() {
		return null;
	},
	update(value, tr) {
		// TODO: I think I need to check navigator clipboard and then update the state
		if (tr.effects.length > 0) {
			try {
				let data = JSON.parse(tr.effects[0].value);
				if (data.type == "copy") {
					console.log(data);
					return data;
				}
				return value;
			} catch (e) {
				console.log(e);
				return value;
			}
		}
		return value;
	},
});

let hoverElement = StateField.define<object | null>({
	create() {
		return null;
	},
	update(value, tr) {
		if (tr.effects.length > 0) {
			try {
				let data = JSON.parse(tr.effects[0].value);
				console.log(tr.effects[0].value);
				if (data.type == "hover-start") {
					console.log(Object.assign({}, data));
					return Object.assign({}, data);
				} else if (data.type == "hover") {
					if (value) console.log(Object.assign(value, data));
					if (value) return Object.assign(value, data);
					return data;
				} else if (data.type == "hover-off") {
					return null;
				}
				return value;
			} catch (e) {
				console.log(e);
				return value;
			}
		}
		return value;
	},
});

let cursorElement = StateField.define<object | null>({
	create() {
		return null;
	},
	update(value, tr) {
		if (tr.effects.length > 0) {
			try {
				let data = JSON.parse(tr.effects[0].value);
				// console.log(tr.effects[0].value);
				if (data.type == "cursor-start") {
					return {};
				} else if (data.type == "cursor") {
					if (value) return Object.assign(value, data);
					return data;
				} else if (data.type == "cursor-off") {
					return null;
				}
				return value;
			} catch (e) {
				console.log(e);
				return value;
			}
		}
		return value;
	},
});

let state: any = EditorState.create({
	extensions: [that, links, hoverElement, cursorElement],
});

const myAnnotation = Annotation.define<any>();
const hoverEffect = StateEffect.define<string>();
const cursorEffect = StateEffect.define<string>();

/* GUTTER */
const emptyMarker = new (class extends GutterMarker {
	toDOM() {
		return document.createTextNode("ø");
	}
})();

const emptyLineGutter = gutter({
	lineMarker(view, line) {
		return line.from == line.to ? emptyMarker : null;
	},
	initialSpacer: () => emptyMarker,
});

/* UTILS */

function findRootSplit(split: any) {
	// If this split has no parent, it's the root.
	if (!split.parent) {
		return split;
	}
	// Otherwise, keep looking upwards.
	return findRootSplit(split.parent);
}

function collectLeavesByTab(split: any, result: any = []) {
	if (split.type == "tabs") {
		result.push([split, []]);
		collectLeavesByTab(split.children, result);
	} else if (split.type == "leaf") {
		const parentSplitId = split.parent.id;
		// find array index for split with id parentSplitId
		let idx = result.findIndex((x: any) => x[0].id == parentSplitId);
		result[idx][1].push(split);
	}

	if (split.children) {
		for (const child of split.children) {
			collectLeavesByTab(child, result);
		}
	}
	return result;
}

function collectLeavesByTabHelper() {
	const { workspace } = state.values[0].app;
	const currLeaf = workspace.getLeaf();
	const rootSplit = findRootSplit(currLeaf);
	return collectLeavesByTab(rootSplit);
}

function getHoveredTab(leavesByTab: any[], span: HTMLSpanElement) {
	const viewContent = span.closest(".view-content");
	if (!viewContent) return;
	const viewHeaderTitle = viewContent.querySelector(".inline-title");
	const currentFile = viewHeaderTitle?.innerHTML + ".md";
	const leaves = leavesByTab.map((el) => el[1]).flat();
	const currTab = leaves.findIndex((x: any) => {
		return x.getViewState().state.file == currentFile;
	});
	return leaves[currTab];
}

function parseEditorPosition(positionString: string) {
	let [line, ch] = positionString.split(",");
	return { line: parseInt(line), ch: parseInt(ch) };
}

function getCurrentTabIndex(leavesByTab: any[], span: HTMLSpanElement) {
	let workspaceTab = span.closest(".workspace-tabs");
	let currTabIdx = leavesByTab.findIndex((x: any) => {
		return x[0].containerEl == workspaceTab;
	});
	return currTabIdx;
}

function getAdjacentTabs(leavesByTab: any[], currTabIdx: number, file: string) {
	let rightAdjacentTab: any[] = [];
	let leftAdjacentTab: any[] = [];
	let adjacentTabs: any[] = [];

	if (leavesByTab[currTabIdx + 1]) {
		rightAdjacentTab = leavesByTab[currTabIdx + 1][1].map((leaf: any) =>
			leaf.getViewState()
		);
		adjacentTabs = [...adjacentTabs, ...rightAdjacentTab];
	}
	if (leavesByTab[currTabIdx - 1]) {
		leftAdjacentTab = leavesByTab[currTabIdx - 1][1].map((leaf: any) =>
			leaf.getViewState()
		);
		adjacentTabs = [...adjacentTabs, ...leftAdjacentTab];
	}

	let index = adjacentTabs.findIndex((x: any) => x.state.file == file);
	return { adjacentTabs, index };
}

async function openFileInAdjacentTab(
	leavesByTab: any[],
	currTabIdx: number,
	file: string
) {
	let { adjacentTabs, index } = getAdjacentTabs(leavesByTab, currTabIdx, file);

	// there are no adjacent tabs
	if (adjacentTabs.length == 0) {
		const { workspace } = state.values[0].app;
		const currLeaf = workspace.getLeaf();
		let newLeaf = workspace.createLeafBySplit(currLeaf);
		await openFileInLeaf(newLeaf, file);
		return newLeaf;
	} else if (index == -1) {
		// leaf doesn't exist in either adjacent tab
		let adjacentTab;
		if (leavesByTab[currTabIdx + 1]) adjacentTab = leavesByTab[currTabIdx + 1];
		else if (leavesByTab[currTabIdx - 1])
			adjacentTab = leavesByTab[currTabIdx - 1];

		if (adjacentTab) {
			let tab = adjacentTab[0];
			let newLeaf: any = this.app.workspace.createLeafInParent(tab, 0);
			await openFileInLeaf(newLeaf, file);
			return newLeaf;
		}
	}
	return null;
}

async function openFileInLeaf(newLeaf: any, file: string) {
	let targetFile: any = this.app.vault.getAbstractFileByPath(file);
	await newLeaf.openFile(targetFile, { active: false });
}

function highlightHoveredText(dataString: string, tabIdx: number) {
	let [text, file, from, to] = dataString.split("|");

	let rangeStart = parseEditorPosition(from);
	let rangeEnd = parseEditorPosition(to);
	const leavesByTab = collectLeavesByTabHelper();
	let rightAdjacentTab = leavesByTab[tabIdx][1].map((leaf: any) =>
		leaf.getViewState()
	);
	let index = rightAdjacentTab.findIndex((x: any) => x.state.file == file);
	if (index != -1) {
		let targetLeaf = leavesByTab[tabIdx][1][index];
		// this.app.workspace.setActiveLeaf(targetLeaf);

		const editor = targetLeaf.view.editor;
		/*
		{
			"top": 0,
			"left": 0,
			"clientHeight": 1311,
			"clientWidth": 1063,
			"height": 1311,
			"width": 1078
		}
		*/
		const originalScroll = editor.getScrollInfo();
		const originalCursor = editor.getCursor();

		editor.replaceRange(`+++${text}+++`, rangeStart, rangeEnd);
		editor.scrollIntoView(
			{
				from: rangeStart,
				to: rangeEnd,
			},
			true
		);
		return {
			tabIdx: tabIdx,
			index,
			dataString,
			originalTop: originalScroll.top,
			originalCursor,
		};
	}
	return null;
}

// [↗](urn:Also-: hopefully fix the multi-line reference:-%0A- URNs:11-23 Todo.md)
// [↗](urn:PREFIX-:TEXT:-SUFFIX:FILE)
async function updateClipboard(only: boolean = false) {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);

	// Make sure the user is editing a Markdown file.
	if (view) {
		let selection = view.editor.getSelection();
		// selection = selection.split("\n").join(" ");

		if (view.file) {
			let reference = `(((${selection}|${view.file.path}|${
				view.editor.getCursor("from").line +
				"," +
				view.editor.getCursor("from").ch
			}|${
				view.editor.getCursor("to").line + "," + view.editor.getCursor("to").ch
			})))`;

			// const text = view.data;
			// const from = view.editor.getCursor("from");
			// const to = view.editor.getCursor("to");

			// let rollingIndex = 0;
			// const lines = text.split("\n").map((line: string, i: number) => {
			// 	let data = { line, index: rollingIndex, length: line.length, i };
			// 	rollingIndex += line.length;
			// 	return data;
			// });

			// let startIndex = lines.filter((line: any) => line.i == from.line)[0];
			// startIndex = startIndex.index + from.ch;
			// let endIndex = lines.filter((line: any) => line.i == to.line)[0];
			// endIndex = endIndex.index + to.ch;
			// // .reduce((a: any, b: any) => a + b, 0);
			// let prefix = text.slice(
			// 	startIndex - 25 > 0 ? startIndex - 25 : 0,
			// 	startIndex + 1
			// );
			// let suffix = text.slice(endIndex, endIndex + 25);

			// let reference = `[↗](urn:${prefix}:${encodeURIComponent(
			// 	selection
			// )}:${suffix}:${view.file.path})`;

			if (!only) {
				reference = '"' + selection + '" ' + reference;
			}

			// Write the selected text to the clipboard
			await navigator.clipboard.writeText(reference);
		}
	}
}

class PlaceholderWidget extends WidgetType {
	constructor(private name: string, private view: EditorView) {
		super();
	}

	eq(other: PlaceholderWidget) {
		return this.name === other.name;
	}

	toDOM() {
		const span = document.createElement("span");

		span.style.backgroundColor = "rgb(187, 215, 230)";
		span.style.color = "black";
		span.setAttribute("class", "old-block");
		span.setAttribute("data", this.name);

		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("fill", "none");
		svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");

		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", "M8 16L0 8L8 0L16 8L8 16Z");
		path.setAttribute("fill", "black");

		svg.appendChild(path);
		span.appendChild(svg);

		span.addEventListener("click", async () => {
			console.log("click");
			console.log(this);
			const { workspace } = state.values[0].app;
			const leavesByTab = collectLeavesByTabHelper();

			const { tabIdx, index, dataString, leafId } = state.values[2];
			/* If temporary, then keep leaf */
			if (dataString) {
				let [text, file, from, to] = dataString.split("|");
				let rangeEnd = parseEditorPosition(to);
				/*
					The problem here is that I don't have the position of the span element.
					I want to set the active cursor to the end of the span
				*/

				let [text2, file2, from2, to2] = this.name.split("|");
				const currentTab = getHoveredTab(leavesByTab, span);
				console.log("currentTab");
				console.log(currentTab);
				let rangeEnd2 = parseEditorPosition(to2);

				const lineText = currentTab?.view?.editor.getLine(rangeEnd2.line);
				console.log(lineText);
				// currentTab.view.editor.setCursor(rangeEnd2);

				let targetLeaf = leavesByTab[tabIdx][1][index];
				workspace.setActiveLeaf(targetLeaf);
				const editor = targetLeaf.view.editor;
				editor.setCursor(rangeEnd);
				state = state.update({
					effects: hoverEffect.of(
						JSON.stringify({
							type: "hover",
							leafId: null,
							originalTop: null,
						})
					),
				}).state;
			}
		});
		return span;
	}
}

const placeholderDecoration = (match: RegExpExecArray, view: EditorView) =>
	Decoration.replace({
		widget: new PlaceholderWidget(match[1], view),
	});

const placeholderMatcher = new MatchDecorator({
	// regexp: /\(\((\w+)\)\)/g,
	regexp: /\(\(\(([\s\S]*?)\)\)\)/g,
	// regexp: /\(\(([^|)]+)\|([^|)]+)\|([^|)]+)\|([^|)]+)\)\)/g,
	// regexp: /\(\(([^-*]+)-\*-([^-*]+)-\*-([^-*]+)-\*-([^-*]+)\)\)/g,
	decoration: (match, view, pos) => {
		console.log(pos);
		return placeholderDecoration(match, view);
	},
});

const placeholders = ViewPlugin.fromClass(
	class {
		placeholders: DecorationSet;
		constructor(view: EditorView) {
			this.placeholders = placeholderMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			this.placeholders = placeholderMatcher.updateDeco(
				update,
				this.placeholders
			);
		}
		destroy() {
			this.placeholders = Decoration.none;
		}
	},
	{
		decorations: (instance) => instance.placeholders,
		provide: (plugin) =>
			EditorView.atomicRanges.of((view) => {
				return view.plugin(plugin)?.placeholders || Decoration.none;
			}),
	}
);

/* new placeholder */
class ReferenceWidget extends WidgetType {
	constructor(private name: string, private view: EditorView) {
		super();
	}

	eq(other: ReferenceWidget) {
		return this.name === other.name;
	}

	toDOM() {
		// if (this.name.split("|").length != 4) {
		// 	console.log("invalid placeholder");
		// 	const regex = /\[↗\]\(urn:([^)]*)\)/g;
		// 	let match = regex.exec(this.name);
		// 	const content = match[1];
		// 	console.log(content); // Output: 'example'
		// 	console.log(content.split(":"));
		// }
		const span = document.createElement("span");

		span.style.backgroundColor = "rgb(187, 215, 230)";
		span.style.color = "black";
		span.setAttribute("class", "old-block");
		const regex = /\[↗\]\(urn:([^)]*)\)/g;
		let match = regex.exec(this.name);
		if (match) {
			const content = match[1];
			span.setAttribute("data", content);
		}

		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("fill", "none");
		svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");

		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", "M8 16L0 8L8 0L16 8L8 16Z");
		path.setAttribute("fill", "black");

		svg.appendChild(path);
		span.appendChild(svg);

		span.addEventListener("click", async () => {
			// console.log("click");
			// console.log(this);
			const { workspace } = state.values[0].app;
			const leavesByTab = collectLeavesByTabHelper();

			const { tabIdx, index, dataString, leafId } = state.values[2];
			/* If temporary, then keep leaf */
			if (dataString) {
				let [text, file, from, to] = dataString.split("|");
				let rangeEnd = parseEditorPosition(to);
				/*
					The problem here is that I don't have the position of the span element.
					I want to set the active cursor to the end of the span
				*/

				let [text2, file2, from2, to2] = this.name.split("|");
				const currentTab = getHoveredTab(leavesByTab, span);
				// console.log("currentTab");
				// console.log(currentTab);
				let rangeEnd2 = parseEditorPosition(to2);

				const lineText = currentTab?.view?.editor.getLine(rangeEnd2.line);
				// console.log(lineText);
				// currentTab.view.editor.setCursor(rangeEnd2);

				let targetLeaf = leavesByTab[tabIdx][1][index];
				workspace.setActiveLeaf(targetLeaf);
				const editor = targetLeaf.view.editor;
				editor.setCursor(rangeEnd);
				state = state.update({
					effects: hoverEffect.of(
						JSON.stringify({
							type: "hover",
							leafId: null,
							originalTop: null,
						})
					),
				}).state;
			}
		});
		return span;
	}
}

const referenceDecoration = (match: RegExpExecArray, view: EditorView) =>
	Decoration.replace({
		widget: new ReferenceWidget(match[0], view),
	});

const referenceMatcher = new MatchDecorator({
	// regexp: /\(\((\w+)\)\)/g,
	// regexp: /\[\u2197\]\(urn:[^\)]*\)/g,
	regexp: /\[\u2197\]\(urn:[\s\S^\)]*\)/g,
	// regexp: /\(\(([^|)]+)\|([^|)]+)\|([^|)]+)\|([^|)]+)\)\)/g,
	// regexp: /\(\(([^-*]+)-\*-([^-*]+)-\*-([^-*]+)-\*-([^-*]+)\)\)/g,
	decoration: (match, view, pos) => {
		return referenceDecoration(match, view);
	},
});

const referenceResources = ViewPlugin.fromClass(
	class {
		referenceResources: DecorationSet;
		constructor(view: EditorView) {
			this.referenceResources = referenceMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			this.referenceResources = referenceMatcher.updateDeco(
				update,
				this.referenceResources
			);
		}
		destroy() {
			this.referenceResources = Decoration.none;
		}
	},
	{
		decorations: (instance) => instance.referenceResources,
		provide: (plugin) =>
			EditorView.atomicRanges.of((view) => {
				return view.plugin(plugin)?.referenceResources || Decoration.none;
			}),
	}
);

/* highlight */
class HighlighterWidget extends WidgetType {
	constructor(private name: string, private view: EditorView) {
		super();
	}

	eq(other: HighlighterWidget) {
		return this.name === other.name;
	}

	toDOM() {
		const span = document.createElement("fragment");
		// console.log(this);
		span.textContent = this.name;
		span.style.backgroundColor = "rgb(187, 215, 230)";
		span.style.color = "black";

		return span;
	}
}

const highlighterDecoration = (match: RegExpExecArray, view: EditorView) =>
	Decoration.replace({
		widget: new HighlighterWidget(match[1], view),
	});

const highlightMatcher = new MatchDecorator({
	// regexp: /\(\((\w+)\)\)/g,
	regexp: /\+\+\+(.*?)\+\+\+/g,
	// regexp: /\(\(([^|)]+)\|([^|)]+)\|([^|)]+)\|([^|)]+)\)\)/g,
	// regexp: /\(\(([^-*]+)-\*-([^-*]+)-\*-([^-*]+)-\*-([^-*]+)\)\)/g,
	decoration: (match, view, pos) => {
		return highlighterDecoration(match, view);
	},
});

const highlights = ViewPlugin.fromClass(
	class {
		highlights: DecorationSet;
		constructor(view: EditorView) {
			this.highlights = highlightMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			this.highlights = highlightMatcher.updateDeco(update, this.highlights);
		}
		destroy() {
			this.highlights = Decoration.none;
		}
	},
	{
		decorations: (instance) => instance.highlights,
		provide: (plugin) =>
			EditorView.atomicRanges.of((view) => {
				return view.plugin(plugin)?.highlights || Decoration.none;
			}),
	}
);

/* Highlight plugin settings */
interface MyHighlightPluginSettings {
	highlightClass: string;
}

const DEFAULT_SETTINGS: MyHighlightPluginSettings = {
	highlightClass: "my-custom-highlight",
};

class MyHighlightPluginSettingTab extends PluginSettingTab {
	plugin: MyHighlightPlugin;

	constructor(app: App, plugin: MyHighlightPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Highlight Class")
			.setDesc("CSS class to apply for highlighting")
			.addText((text) =>
				text
					.setPlaceholder("Enter CSS class")
					.setValue(this.plugin.settings.highlightClass)
					.onChange(async (value) => {
						this.plugin.settings.highlightClass = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

export default class MyHighlightPlugin extends Plugin {
	settings: MyHighlightPluginSettings;

	// Need to do cleanup, any highlights that are still present
	// Or on reload command

	// need to load all pages and process any backlinks

	// This function would save the SVG as a file and return the path.
	async saveSvgAsFile(svgContent: string, filename: string): Promise<string> {
		const fileUri = `./links/${filename}.svg`;
		// Make sure to handle path creation and check if a file already exists if needed.

		await this.app.vault.adapter.write(fileUri, svgContent);

		return fileUri;
	}

	// [↗](urn:Also-: hopefully fix the multi-line reference:-%0A- URNs:11-23 Todo.md)
	findTextPositions(
		searchTerm: string,
		prefix: string = "",
		suffix: string = ""
	) {
		const activeLeaf: any = this.app.workspace.getLeaf();
		if (!activeLeaf) return;

		// Make sure the view is in source mode and has a CodeMirror editor instance
		if (
			activeLeaf.view.getViewType() === "markdown" &&
			activeLeaf.view.editor
		) {
			const editor = activeLeaf.view.editor;

			console.log(prefix, suffix);
			console.log(searchTerm);
			// const test = new SearchCursor(Text.of(activeLeaf.view.data), searchTerm);
			// given text and search term, find all matches

			let rollingIndex = 0;
			const text = activeLeaf.view.data;
			const lines = text.split("\n").map((line: string) => {
				let data = { line, index: rollingIndex, length: line.length };
				rollingIndex += line.length;
				return data;
			});
			console.log("lines: ");
			console.log(lines);
			// console.log(cursorFrom);
			// console.log(cursorTo);

			console.log(decodeURIComponent(prefix + searchTerm + suffix));
			const matches = [
				...activeLeaf.view.data.matchAll(
					decodeURIComponent(prefix + searchTerm + suffix)
				),
			];
			// console.log("matches: ");
			// console.log(matches);
			matches.forEach((match) => {
				// console.log(match.index);
				let startIndex =
					lines.findIndex((line: any) => line.index >= match.index) - 1;
				let endIndex =
					lines.findIndex(
						(line: any) => line.index >= match.index + match[0].length
					) - 1;
				console.log(startIndex);
				const selection = editor.getRange(
					{
						line: startIndex,
						ch: match.index - lines[startIndex].index - startIndex,
					},
					{
						line: endIndex,
						ch:
							match.index + match[0].length - lines[endIndex].index - endIndex,
					}
				);
				console.log(selection);
			});
		}
	}

	async startEffect(span: HTMLSpanElement, type: string) {
		let source = type == "hover" ? state.values[2] : state.values[3];
		let destination = type == "hover" ? state.values[3] : state.values[2];
		let stateMutation = type == "hover" ? hoverEffect : cursorEffect;

		// Mutex, prevent concurrent access to following section of code
		if (source != null) return;
		state = state.update({
			effects: stateMutation.of(
				JSON.stringify({
					type: `${type}-start`,
				})
			),
		}).state;

		const dataString = span.getAttribute("data");
		if (!dataString) return;

		if (destination != null && destination.dataString == dataString) {
			const data = destination;
			state = state.update({
				effects: hoverEffect.of(JSON.stringify(Object.assign(data, { type }))),
			}).state;
			return;
		}

		let [prefix, text, suffix, file] = dataString.split(":");
		console.log(dataString);
		if (prefix && suffix && text && file) {
			this.findTextPositions(
				text,
				prefix.slice(0, prefix.length - 1),
				suffix.slice(1, suffix.length)
			);
		}

		let leavesByTab = collectLeavesByTabHelper();
		let currTabIdx = getCurrentTabIndex(leavesByTab, span);

		if (currTabIdx != -1) {
			// && currTab != -1) {
			// Check adjacent tabs for file and open file if needed
			const newLeaf = await openFileInAdjacentTab(
				leavesByTab,
				currTabIdx,
				file
			);
			if (newLeaf) {
				state = state.update({
					effects: stateMutation.of(
						JSON.stringify({
							type,
							leafId: newLeaf.id,
						})
					),
				}).state;
			}

			leavesByTab = collectLeavesByTabHelper();

			// highlight reference in the right tab
			if (leavesByTab[currTabIdx + 1]) {
				const data = highlightHoveredText(dataString, currTabIdx + 1);
				if (data) {
					state = state.update({
						effects: stateMutation.of(
							JSON.stringify(Object.assign(data, { type }))
						),
					}).state;
				}
				return;
			}

			// highlight reference in the left tab
			if (leavesByTab[currTabIdx - 1]) {
				const data = highlightHoveredText(dataString, currTabIdx - 1);
				if (data) {
					state = state.update({
						effects: stateMutation.of(
							JSON.stringify(Object.assign(data, { type }))
						),
					}).state;
				}
				return;
			}
		}
	}

	async endCursorEffect() {
		const leavesByTab = collectLeavesByTabHelper();
		if (!state.values[3]) return;

		const { tabIdx, index, dataString, leafId, originalTop, originalCursor } =
			state.values[3];

		if (state.values[2] != null && state.values[2].dataString == dataString) {
			// End mutex lock
			state = state.update({
				effects: cursorEffect.of(
					JSON.stringify({
						type: "cursor-off",
					})
				),
			}).state;
			return;
		}

		if (dataString) {
			let [text, file, from, to] = dataString.split("|");
			let rangeStart = parseEditorPosition(from);
			let rangeEnd = parseEditorPosition(to);

			let targetLeaf = leavesByTab[tabIdx][1][index];
			// this.app.workspace.setActiveLeaf(targetLeaf);
			const editor = targetLeaf.view.editor;

			editor.replaceRange(
				text,
				rangeStart,
				Object.assign({}, rangeEnd, { ch: rangeEnd.ch + 6 })
			);
			editor.scrollIntoView(
				{
					from: rangeStart,
					to: rangeEnd,
				},
				true
			);
			// console.log(selection);

			// console.log("originalTop: " + originalTop);
			if (leafId) {
				await targetLeaf.detach();
			}
		}
		// End mutex lock
		state = state.update({
			effects: cursorEffect.of(
				JSON.stringify({
					type: "cursor-off",
				})
			),
		}).state;
	}

	async endHoverEffect() {
		const leavesByTab = collectLeavesByTabHelper();
		if (!state.values[2]) return;
		const { tabIdx, index, dataString, leafId, originalTop, originalCursor } =
			state.values[2];

		if (state.values[3] != null && state.values[3].dataString == dataString) {
			// End mutex lock
			state = state.update({
				effects: hoverEffect.of(
					JSON.stringify({
						type: "hover-off",
					})
				),
			}).state;
			return;
		}

		if (dataString) {
			let [text, file, from, to] = dataString.split("|");
			let rangeStart = parseEditorPosition(from);
			let rangeEnd = parseEditorPosition(to);

			let targetLeaf = leavesByTab[tabIdx][1][index];
			// this.app.workspace.setActiveLeaf(targetLeaf);
			const editor = targetLeaf.view.editor;

			editor.replaceRange(
				text,
				rangeStart,
				Object.assign({}, rangeEnd, { ch: rangeEnd.ch + 6 })
			);

			// scroll to cursor hover if it exists
			if (state.values[3] && state.values[3].dataString) {
				console.log("DATASTRING");

				let [text, file, from, to] = state.values[3].dataString.split("|");
				let rangeStart = parseEditorPosition(from);
				let rangeEnd = parseEditorPosition(to);

				editor.scrollIntoView(
					{
						from: rangeStart,
						to: rangeEnd,
					},
					true
				);
			} else {
				editor.scrollIntoView(
					{
						from: rangeStart,
						to: rangeEnd,
					},
					true
				);
			}

			// console.log(selection);

			// console.log("originalTop: " + originalTop);
			if (leafId) {
				await targetLeaf.detach();
			}
		}

		// End mutex lock
		state = state.update({
			effects: hoverEffect.of(
				JSON.stringify({
					type: "hover-off",
				})
			),
		}).state;
	}

	async onload() {
		await this.loadSettings();

		// that = this;

		state = state.update({
			annotations: myAnnotation.of(this),
		}).state;

		this.registerEditorExtension([
			// emptyLineGutter,
			placeholders,
			highlights,
			referenceResources,
		]);

		this.registerDomEvent(document, "mousemove", async (evt) => {
			let span;
			let dataString;
			if (
				evt.target &&
				(evt.target instanceof HTMLSpanElement ||
					evt.target instanceof SVGElement ||
					evt.target instanceof SVGPathElement)
			) {
				// console.log("MOUSEMOVE");
				// If element is svg, find the containing parent span
				span = evt.target;

				while (
					!(span instanceof HTMLSpanElement) &&
					span.parentElement != null
				) {
					span = span.parentElement;
				}
				dataString = span.getAttribute("data");
			}

			if (dataString && span && span instanceof HTMLSpanElement) {
				this.startEffect(span, "hover");
			} else if (state.values[2] != null) {
				// console.log("MOUSEOUT");
				// console.log(evt);
				this.endHoverEffect();
			}
		});

		this.registerDomEvent(document, "click", async (evt) => {
			this.checkFocusCursor(evt);
		});

		this.registerDomEvent(document, "keydown", async (evt) => {
			if (!(evt.key == "z" && evt.metaKey)) {
				// Timeout fix: it doesn't recognize the latest paste change immediately because the paste event might not trigger the DOM change event.
				setTimeout(() => {
					this.checkFocusCursor(evt);
				}, 50);
			} else {
				let { matched, span } = this.checkCursorPositionAtDatastring(evt);

				if (matched) {
					if (
						state.values[2] != null &&
						state.values[3] != null &&
						state.values[2].dataString == state.values[3].dataString
					) {
						console.log("UNDO HOVER");
						state = state.update({
							effects: hoverEffect.of(
								JSON.stringify({
									type: "hover-off",
								})
							),
						}).state;
					}

					console.log("UNDO CURSOR");
					state = state.update({
						effects: cursorEffect.of(
							JSON.stringify({
								type: "cursor-off",
							})
						),
					}).state;
					const activeView =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					activeView?.editor.undo();
				}
			}

			if (evt.key == "c" && evt.metaKey && evt.shiftKey) {
				console.log("c");
				updateClipboard();
			} else if (evt.key == "d" && evt.metaKey && evt.shiftKey) {
				console.log("d");
				updateClipboard(true);
			}
		});

		// this.registerEvent(
		// 	this.app.workspace.on("editor-change", (ev) => {
		// 		console.log("editor-change");
		// 		console.log(ev);
		// 		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		// 		const cursorFrom = activeView?.editor.getCursor("from");
		// 		const cursorTo = activeView?.editor.getCursor("to");
		// 		if (cursorFrom) {
		// 			const lineText = activeView?.editor.getLine(cursorFrom.line);
		// 			console.log(lineText);
		// 		}

		// 		// this.endCursorEffect();
		// 		// this.endHoverEffect();
		// 	})
		// );

		// this.registerEvent(
		// 	this.app.workspace.on("codemirror", (ev) => {
		// 		console.log("codemirror");
		// 		console.log(ev);
		// 		// this.endCursorEffect();
		// 		// this.endHoverEffect();
		// 	})
		// );

		this.registerEvent(
			this.app.workspace.on("file-open", this.onFileOpenOrSwitch.bind(this))
		);

		this.registerMarkdownPostProcessor((element, context) => {
			const codeblocks = element.findAll("code");

			for (let codeblock of codeblocks) {
				// console.log(codeblock);
			}
		});

		this.addSettingTab(new MyHighlightPluginSettingTab(this.app, this));
	}

	onunload() {}

	checkCursorPositionAtDatastring(evt: Event | { target: HTMLElement }): any {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cursorFrom = activeView?.editor.getCursor("from");
		const cursorTo = activeView?.editor.getCursor("to");

		// console.log(cursorFrom);
		// console.log(cursorTo);

		let matched = false;
		let matchSpan;
		if (
			cursorFrom &&
			cursorTo &&
			cursorFrom.ch == cursorTo.ch &&
			cursorFrom.line == cursorTo.line
			// &&cursorFrom.ch - 1 >= -1
		) {
			const lineText = activeView?.editor.getLine(cursorFrom.line);
			// console.log(lineText);

			// Match the regex pattern to lineText
			const regex = /\(\(\(([\s\S]*?)\)\)\)/g;
			// from possible regex matches in lineText
			if (lineText) {
				const matches = [...lineText.matchAll(regex)];
				matches.forEach((match) => {
					// console.log(match);
					if (match.index?.toString()) {
						const start = match.index;
						const end = start + match[0].length;
						if (end == cursorTo.ch && evt.target) {
							const dataString = match[1];
							// get the html element at the match location
							const container: any = evt.target;
							// console.log(container);
							// find html span element in target that has a data attribute equal to contents
							let span = container.querySelector(`span[data="${dataString}"]`);
							if (span && span instanceof HTMLSpanElement) {
								console.log("Found span element:", span);
								// Do something with the span element
								matched = true;

								console.log(dataString);
								console.log(span);

								matchSpan = span;
							} else {
								console.log("Span element not found");
							}
						}
					}
				});
			}
		}
		return { matched, span: matchSpan };
	}

	checkFocusCursor(evt: Event | { target: HTMLElement }) {
		let { matched, span } = this.checkCursorPositionAtDatastring(evt);

		if (matched) {
			this.endCursorEffect();
			// this.startCursorEffect(span);
			this.startEffect(span, "cursor");
		} else {
			this.endCursorEffect();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onFileOpenOrSwitch() {
		// console.log("file open");
		const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
	}
}
