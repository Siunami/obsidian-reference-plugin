import {
	TAbstractFile,
	TFile,
	Workspace,
	WorkspaceLeaf,
	WorkspaceRoot,
	WorkspaceSplit,
	WorkspaceTabs,
} from "obsidian";
import { getThat } from "./state";
import { getContainerElement } from "./references";

function collectLeavesByTab(
	split: WorkspaceSplit,
	result: [WorkspaceLeaf[]] | [] = []
) {
	// @ts-ignore
	const type = split.type;
	if (!type) throw new Error("Split type not found");

	if (type == "tabs" || type == "split") {
		// @ts-ignore
		const children = split.children;
		if (!children) throw new Error("Split children not found");

		if (children) {
			for (const child of children) {
				collectLeavesByTab(child, result);
			}
		}
	} else if (type == "leaf") {
		// @ts-ignore
		const parentSplitId = split.parent.id;
		if (!parentSplitId) throw new Error("Split parent id not found");

		// find array index for split with id parentSplitId
		let idx = result.findIndex((tab: WorkspaceLeaf[]) => {
			// @ts-ignore
			const tabId = tab[0].parent.id;
			return tabId == parentSplitId;
		});
		if (idx == -1) {
			// @ts-ignore
			result.push([split as WorkspaceLeaf]);
		} else {
			result[idx].push(split as WorkspaceLeaf);
		}
	}

	return result;
}

export function collectLeavesByTabHelper() {
	const { workspace } = getThat();
	const currLeaf: WorkspaceLeaf = workspace.getLeaf();
	// const rootSplit = findRootSplit(currLeaf);
	const rootSplit: WorkspaceSplit = currLeaf.getRoot();
	return collectLeavesByTab(rootSplit);
}

export function getCurrentTabIndex(leavesByTab: any[], span: HTMLSpanElement) {
	let workspaceTab = span.closest(".workspace-tabs");
	let currTabIdx = leavesByTab.findIndex((tab: WorkspaceLeaf[]) => {
		const leafTab = tab[0].view.containerEl.closest(".workspace-tabs");
		return leafTab == workspaceTab;
	});
	return currTabIdx;
}

/**
 * Get the adjacent tabs to the current tab
 * @param leavesByTab
 * @param currTabIdx
 * @param file
 * @returns
 */
export function getAdjacentTabs(
	leavesByTab: [WorkspaceLeaf[]] | [],
	currTabIdx: number,
	file: string
): {
	rightAdjacentTab: WorkspaceLeaf[];
	leftAdjacentTab: WorkspaceLeaf[];
	index: number;
} {
	let rightAdjacentTab: WorkspaceLeaf[] = [];
	let leftAdjacentTab: WorkspaceLeaf[] = [];
	let adjacentTabs: WorkspaceLeaf[] = [];

	if (leavesByTab[currTabIdx + 1]) {
		rightAdjacentTab = leavesByTab[currTabIdx + 1];
		adjacentTabs = [...adjacentTabs, ...rightAdjacentTab];
	}
	if (leavesByTab[currTabIdx - 1]) {
		leftAdjacentTab = leavesByTab[currTabIdx - 1];
		adjacentTabs = [...adjacentTabs, ...leftAdjacentTab];
	}

	let index = adjacentTabs.findIndex(
		(x: WorkspaceLeaf) => x.getViewState().state.file == file
	);
	return { rightAdjacentTab, leftAdjacentTab, index };
}

/**
 * Open a file in an adjacent tab if it exists, otherwise create a new tab with that file
 * @param leavesByTab the leaves in the workspace organized by tab
 * @param currTabIdx the index of the current tab
 * @param file the file to open
 * @returns
 */
export async function openFileInAdjacentTab(
	leavesByTab: [WorkspaceLeaf[]] | [],
	currTabIdx: number,
	file: string
): Promise<{
	newLeaf: WorkspaceLeaf;
	temp: boolean;
	originalLeaf: WorkspaceLeaf;
}> {
	let { rightAdjacentTab, leftAdjacentTab } = getAdjacentTabs(
		leavesByTab,
		currTabIdx,
		file
	);

	let allTabNames = leavesByTab.map((tab: WorkspaceLeaf[]) =>
		tab.map((x: WorkspaceLeaf) => x.getViewState().state.file)
	);
	let rightAdjacentTabNames = rightAdjacentTab.map(
		(x: WorkspaceLeaf) => x.getViewState().state.file
	);
	let leftAdjacentTabNames = leftAdjacentTab.map(
		(x: WorkspaceLeaf) => x.getViewState().state.file
	);
	const { workspace } = getThat();
	if (
		allTabNames
			.filter((v, i) => i != currTabIdx)
			.flat()
			.includes(file) &&
		!rightAdjacentTabNames.includes(file) &&
		!leftAdjacentTabNames.includes(file)
	) {
		// file exists, not adjacent left or right tab
		let currentTabNames: any[] = [];
		let currentTab: any[] = [];
		allTabNames.forEach((tabNames, i) => {
			if (
				tabNames != rightAdjacentTabNames &&
				tabNames != leftAdjacentTabNames &&
				currTabIdx != i
			) {
				if (tabNames.includes(file)) {
					currentTabNames = tabNames;
					currentTab = leavesByTab[i];
				}
			}
		});

		const originalLeaf = currentTab.filter(
			(t) => t.containerEl.style.display != "none"
		)[0];
		let leaf = currentTab[currentTabNames.indexOf(file)];
		workspace.revealLeaf(leaf);

		// console.log("open file new tab");
		return { newLeaf: leaf, temp: false, originalLeaf };
	} else if (rightAdjacentTabNames.includes(file)) {
		// file exists in right tab
		const originalLeaf = rightAdjacentTab.filter(
			(t) => getContainerElement(t).style.display != "none"
		)[0];
		let leaf = rightAdjacentTab[rightAdjacentTabNames.indexOf(file)];
		workspace.revealLeaf(leaf);

		// console.log("open existing file right tab");
		return { newLeaf: leaf, temp: false, originalLeaf };
	} else if (leftAdjacentTabNames.includes(file)) {
		// file exists in left tab
		const originalLeaf = leftAdjacentTab.filter(
			(t) => getContainerElement(t).style.display != "none"
		)[0];

		let leaf = leftAdjacentTab[leftAdjacentTabNames.indexOf(file)];
		workspace.revealLeaf(leaf);

		// console.log("open existing file left tab");
		return { newLeaf: leaf, temp: false, originalLeaf };
	} else if (rightAdjacentTab.length > 0) {
		// there exists a right tab
		const originalLeaf = rightAdjacentTab.filter(
			(t) => getContainerElement(t).style.display != "none"
		)[0];

		let currLeaf = workspace.getLeaf();
		workspace.setActiveLeaf(originalLeaf);
		let newLeaf = workspace.getLeaf(true);
		await openFileInLeaf(newLeaf, file);
		workspace.revealLeaf(newLeaf);
		workspace.setActiveLeaf(currLeaf);

		// console.log("open new file right tab");
		return { newLeaf, temp: true, originalLeaf };
	} else if (leftAdjacentTab.length > 0) {
		// there exists a left tab
		const originalLeaf = leftAdjacentTab.filter(
			(t) => getContainerElement(t).style.display != "none"
		)[0];

		let currLeaf = workspace.getLeaf(); // get current active leaf
		workspace.setActiveLeaf(originalLeaf); // get the leaf in adjacent tab
		let newLeaf = workspace.getLeaf(true); // create a new leaf
		await openFileInLeaf(newLeaf, file); // load file into new leaf
		workspace.revealLeaf(newLeaf); // reveal new leaf
		workspace.setActiveLeaf(currLeaf); // set active leaf back to original

		// console.log("open new file left tab");
		return { newLeaf, temp: true, originalLeaf };
	} else {
		// no adjacent tabs
		const currLeaf = workspace.getLeaf();
		let newLeaf = workspace.createLeafBySplit(currLeaf);
		await openFileInLeaf(newLeaf, file);

		// console.log("open new file left tab");
		return { newLeaf, temp: true, originalLeaf: currLeaf };
	}
}

export async function openFileInLeaf(leaf: WorkspaceLeaf, file: string) {
	let targetFile: TAbstractFile | null =
		getThat().vault.getAbstractFileByPath(file);
	if (targetFile && targetFile instanceof TFile)
		await leaf.openFile(targetFile, { active: false });
}
