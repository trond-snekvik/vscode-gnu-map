/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';

class SymbolParser implements vscode.DocumentSymbolProvider {
	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({language: 'mapfile', scheme: 'file'}, this));
	}

	parseSymbols(document: vscode.TextDocument) {
		const extendRange = (entry: { range: vscode.Range }, number: number) => entry.range = new vscode.Range(entry.range.start, new vscode.Position(number - 1, 9999999));
		const formatAddr = (addr: string) => '0x' + parseInt(addr).toString(16); // remove leading 0s
		const sections = new Array<{name: string, range: vscode.Range, entries: vscode.DocumentSymbol[]}>();
		const lines = document.getText().split(/\r?\n/g);
		let continuesOnNextLine: vscode.DocumentSymbol | null;
		let indent = '';
		lines.forEach((line, number) => {
			// Parse entry address if it ends up on the next line:
			if (continuesOnNextLine) {
				if (!line.match(/^\s*\.[\w+]/)) {
					if (!continuesOnNextLine.name.length) {
						const obj = line.match(/.*(?:\(([\w.-]*?)\))?/);
						const path = obj?.[0].trim().split(/\s+/g).pop()?.split(/[\\/]/g).pop();
						if (obj?.[1]) {
							continuesOnNextLine.name = obj[1];
						} else if (path) {
							continuesOnNextLine.name = path;
						} else {
							continuesOnNextLine.name = continuesOnNextLine.detail; // fallback
							continuesOnNextLine.detail = '';
						}
					} else {
						const obj = line.match(/.*\(([\w.-]*?)\)/)?.[1];
						if (obj && obj !== continuesOnNextLine.name) {
							continuesOnNextLine.detail = obj;
						}
					}

					continuesOnNextLine.range = new vscode.Range(continuesOnNextLine.range.start, new vscode.Position(number, line.length));
					continuesOnNextLine = null;
					return;
				} else {
					continuesOnNextLine = null;
				}
			}

			const section = sections[sections.length - 1];

			const heading = line.match(/^(Discarded input sections|Archive member included to satisfy reference by file \(symbol\)|Memory Configuration|Linker script and memory map|Allocating common symbols)$/);
			if (heading) {
				// End the previous section on the previous line:
				if (section) {
					extendRange(section, number);
				}

				const pos = new vscode.Position(number, 0);
				sections.push({name: heading[0], range: new vscode.Range(pos, pos), entries: []});
				return;
			}

			if (section) {
				// End the previous entry on the previous line:
				if (section.entries.length && !line.startsWith(' ')) {
					const prev = section.entries[section.entries.length - 1];
					extendRange(prev, number);
					if (prev.children.length) {
						extendRange(prev.children[prev.children.length - 1], number);
					}
				}

				const operator = line.match(/^(LOAD|\/DISCARD\/|OUTPUT)\s*(.*)/);
				if (operator) {
					const range = new vscode.Range(number, 0, number, line.length);
					const entry = new vscode.DocumentSymbol(operator[1], operator[2], vscode.SymbolKind.Method, range, range);
					section.entries.push(entry);
					return;
				}

				if (!section.entries.length) {
					const tableHeaders = line.match(/^(Name\s+Origin\s+Length\s+Attributes|Common\s+symbol\s+size\s+file)$/);
					if (tableHeaders) {
						return; // Ignore header
					}
				}

				const path = line.match(/^((?:[A-Za-z]:\/|\/)?(?:[~+$%&.\w-]+[\\/])+[~+$%&.\w-]+)(?:\((.*?)\))?/);
				if (path) {
					const range = new vscode.Range(number, 0, number, line.length);
					const entry = new vscode.DocumentSymbol(path[2] ?? path[1], path[2] ? path[1] : '', vscode.SymbolKind.File, range, range);
					section.entries.push(entry);
					return;
				}

				const symbol = line.match(/^((?:[.\w-]+|\."[\w./-]+")+)(?:\s+(0x[\da-fA-F]+))?/);
				if (symbol) {
					const range = new vscode.Range(number, 0, number, line.length);
					const entry = new vscode.DocumentSymbol(symbol[1], '', vscode.SymbolKind.Field, range, range);
					if (symbol[2]) {
						entry.detail = formatAddr(symbol[2]);
					} else {
						continuesOnNextLine = entry;
					}

					indent = '';
					section.entries.push(entry);
					return;
				}

				const subSymbol = line.match(/^(\s+)((?:\.[\w-]+|\."[\w./-]+")+)(?:.*\((.*?)\)|(.*))?/);
				if (subSymbol) {
					const range = new vscode.Range(number, 0, number, line.length);
					const entry = new vscode.DocumentSymbol(subSymbol[2], '', vscode.SymbolKind.Field, range, range);
					if (subSymbol[3]) {
						entry.detail = subSymbol[3];
					} else if (subSymbol[4]) {
						entry.detail = entry.name;
						entry.name = subSymbol[4].trim().split(/\s+/g).pop()?.split(/[\\/]/g).pop() ?? entry.name;
					} else {
						continuesOnNextLine = entry;
					}

					if (section.entries.length && indent.length < subSymbol[1].length) {
						const subsection = section.entries[section.entries.length - 1];
						subsection.children.push(entry);
						subsection.kind = vscode.SymbolKind.Variable;

						// Common scenario: There's an entry like ".debug", that contains identical ".debug" child entries for each object.
						// Swap the detail and name:
						if (subsection.name === entry.name) {
							entry.detail = subsection.name;
							if (subSymbol[3]) {
								entry.name = subSymbol[3];
							} else {
								entry.name = '';
								continuesOnNextLine = entry; // object name goes on next line, parse then
							}
						}
					} else {
						section.entries.push(entry);
						indent = subSymbol[1];
					}
					return;
				}
			}
		});

		// The last section should go to the end of the file:
		if (sections.length) {
			const lastSection = sections[sections.length - 1];
			extendRange(lastSection, lines.length);
			if (lastSection.entries.length) {
				const lastEntry = lastSection.entries[lastSection.entries.length - 1];
				extendRange(lastEntry, lines.length);
				if (lastEntry.children.length) {
					extendRange(lastEntry.children[lastEntry.children.length - 1], lines.length);
				}
			}
		}

		return sections;
	}

	provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[] | vscode.DocumentSymbol[]> {
		return this.parseSymbols(document).map(section => {
			const symbol = new vscode.DocumentSymbol(section.name, '', vscode.SymbolKind.Class, section.range, new vscode.Range(section.range.start.line, 0, section.range.start.line, section.name.length));
			symbol.children = section.entries;
			return symbol;
		});
	}
}

export function activate(context: vscode.ExtensionContext) {
	new SymbolParser(context);
}

export function deactivate() {}
