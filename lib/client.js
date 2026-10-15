window.__ModuleLoader__.load({ id: "dsh-workbuddy2dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_dom = require("react-dom");
react_dom = __toESM(react_dom);
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/chip-readout.ts
/** What the chip shows for one status reading. */
function resolve(status) {
	if (!status.reachable) return {
		mode: "offline",
		error: status.error
	};
	if (status.freeModels.length + status.accountModels.length === 0 && status.pool.total === 0) return { mode: "empty" };
	return {
		mode: "ready",
		freeCount: status.freeModels.length,
		accountCount: status.accountModels.length,
		healthy: status.pool.healthy,
		total: status.pool.total
	};
}
/** The trigger's short label. */
function chipValue(state, t) {
	if (state.mode === "offline") return t("chipValueOffline");
	if (state.mode === "empty") return t("chipValueEmpty");
	return t("chipValueReady", { free: state.freeCount });
}
/** The tooltip's full sentence. */
function chipTitle(status, state, t) {
	if (state.mode === "offline") return status.error ? `${t("chipOffline")}: ${status.error}` : t("chipOffline");
	if (state.mode === "empty") return t("chipEmpty");
	const s = state;
	return t("chipReady", {
		free: s.freeCount,
		account: s.accountCount,
		healthy: s.healthy,
		total: s.total
	});
}
/** Health for the trigger's border colour. */
function chipHealth(state) {
	if (state.mode === "ready") return state.healthy > 0 ? "ok" : "bad";
	if (state.mode === "offline") return "bad";
	return "flat";
}
/**
* A price line for one model, as the panel's catalogue states it.
*
* The gateway sends a promotion as a pair — a `promo_factor` multiplier and a
* human label — and the list price stays what it was. Showing only the factor
* would hide that a promotion is temporary; showing only the list price would
* claim a model costs what it did before the promotion started. Both, with the
* factor struck out, is what the WorkBuddy client itself does.
*/
function priceLine(row) {
	if (row.promoFactor === 0) return {
		current: "0.00",
		label: row.promoLabel || "Free now",
		struck: row.credits && parseCreditsNumber(row.credits) !== 0 ? row.credits : null
	};
	if (row.promoFactor !== null && row.promoFactor > 0) return {
		current: formatFactor(row.promoFactor),
		label: row.promoLabel,
		struck: row.credits || null
	};
	const numeric = parseCreditsNumber(row.credits);
	return {
		current: numeric === null ? "—" : formatCredits(numeric),
		label: "",
		struck: null
	};
}
/** The numeric multiplier out of the gateway's `credits` string, or null. */
function parseCreditsNumber(credits) {
	if (typeof credits !== "string") return null;
	const match = /-?\d+(?:\.\d+)?/.exec(credits);
	if (!match) return null;
	const value = Number(match[0]);
	return Number.isFinite(value) ? value : null;
}
/** A promotion factor as a price: `0.5` reads as `x0.50`. */
function formatFactor(factor) {
	return `x${factor.toFixed(2)}`;
}
/** A plain multiplier as a price, always two decimals. */
function formatCredits(value) {
	return value.toFixed(2);
}

//#endregion
//#region \0dsh-css:C:\Users\mirel\.dsh\plugins\dsh-workbuddy2dsh\src\client\chip.module.css.mjs
const css = ".WsHpUa_chipRoot{flex:none;display:inline-flex}.WsHpUa_chipTrigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}.WsHpUa_chipTrigger:hover,.WsHpUa_chipTrigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.WsHpUa_chipIcon{flex:none}.WsHpUa_chipIcon[data-health=ok]{color:var(--dsw-alias-state-success-primary,#1a7f37)}.WsHpUa_chipIcon[data-health=bad]{color:var(--dsw-alias-state-error-primary,#d1242f)}.WsHpUa_chipPanel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(340px,100vw - 24px);max-height:calc(100vh - 48px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;flex-direction:column;align-items:stretch;padding:12px;font-size:12px;line-height:20px;display:flex;position:fixed;overflow-y:auto}.WsHpUa_chipPanelHead{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:8px;display:flex}.WsHpUa_chipPanelTitle{color:var(--dsw-alias-label-secondary);font-weight:600}.WsHpUa_chipFigures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}.WsHpUa_chipPanelLink{border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-state-business-primary,#4f8cff);cursor:pointer;align-self:flex-start;align-items:center;gap:6px;margin-top:8px;padding:4px 10px;font-family:inherit;font-size:12px;text-decoration:none;display:inline-flex}.WsHpUa_chipPanelLink:hover{background:var(--dsw-alias-interactive-bg-hover)}.WsHpUa_chipPanelLink:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px}.WsHpUa_chipFacts{color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:4px 10px;margin:8px 0 2px;font-size:11px;display:flex}.WsHpUa_chipFact{align-items:baseline;gap:4px;display:inline-flex}.WsHpUa_chipFactValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500}.WsHpUa_chipGroupLabel{letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);flex:none;margin:10px 0 2px;font-size:10px;font-weight:600}.WsHpUa_chipRow{border-radius:var(--dsw-radius-sm);width:100%;color:var(--dsw-alias-label-secondary);text-align:left;background:0 0;border:none;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;padding:3px 8px 3px 4px;font-family:inherit;font-size:12px;line-height:18px;display:grid}.WsHpUa_chipRowLabel{flex-direction:column;min-width:0;display:flex;overflow:hidden}.WsHpUa_chipRowName{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.WsHpUa_chipRowSub{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden}.WsHpUa_chipPrice{font-variant-numeric:tabular-nums;white-space:nowrap;align-items:baseline;gap:5px;display:inline-flex}.WsHpUa_chipPriceNow{color:var(--dsw-alias-label-primary);font-weight:500}.WsHpUa_chipPriceFree{color:var(--dsw-alias-state-success-primary,#1a7f37)}.WsHpUa_chipPriceWas{color:var(--dsw-alias-label-tertiary);font-size:10px;text-decoration:line-through}.WsHpUa_chipEmpty{color:var(--dsw-alias-label-tertiary);padding:8px 0}.WsHpUa_chipOfflineNote{color:var(--dsw-alias-state-error-primary,#d1242f);overflow-wrap:anywhere;padding:8px 0 2px;font-size:11px}";
const tagId = "dsh-workbuddy2dsh/chip.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-workbuddy2dsh";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var chip_module_css_default = {
	"chipPriceFree": "WsHpUa_chipPriceFree",
	"chipPanelHead": "WsHpUa_chipPanelHead",
	"chipRow": "WsHpUa_chipRow",
	"chipFactValue": "WsHpUa_chipFactValue",
	"chipRowLabel": "WsHpUa_chipRowLabel",
	"chipPrice": "WsHpUa_chipPrice",
	"chipPanelTitle": "WsHpUa_chipPanelTitle",
	"chipFact": "WsHpUa_chipFact",
	"chipPriceWas": "WsHpUa_chipPriceWas",
	"chipFigures": "WsHpUa_chipFigures",
	"chipIcon": "WsHpUa_chipIcon",
	"chipTrigger": "WsHpUa_chipTrigger",
	"chipPanel": "WsHpUa_chipPanel",
	"chipRoot": "WsHpUa_chipRoot",
	"chipRowName": "WsHpUa_chipRowName",
	"chipRowSub": "WsHpUa_chipRowSub",
	"chipPriceNow": "WsHpUa_chipPriceNow",
	"chipPanelLink": "WsHpUa_chipPanelLink",
	"chipFacts": "WsHpUa_chipFacts",
	"chipGroupLabel": "WsHpUa_chipGroupLabel",
	"chipEmpty": "WsHpUa_chipEmpty",
	"chipOfflineNote": "WsHpUa_chipOfflineNote"
};

//#endregion
//#region src/client/WorkbuddyChip.tsx
/** The status route this plugin's runtime registers. Same-origin, no key. */
const BRIDGE_PREFIX = "/api/workbuddy2dsh";
/** How often the readout refreshes while the composer is mounted. */
const POLL_MS = 15e3;
/** How many models each lane shows before it is summarised instead. */
const ROWS_PER_LANE = 8;
async function readStatus() {
	try {
		const response = await fetch(`${BRIDGE_PREFIX}/status`, { signal: AbortSignal.timeout(8e3) });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}
/** One model row: its name, its lane, and what it costs right now. */
function ModelLine({ row }) {
	const price = priceLine(row);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: chip_module_css_default.chipRow,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: chip_module_css_default.chipRowLabel,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: chip_module_css_default.chipRowName,
				children: row.name || row.id
			}), price.label !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: chip_module_css_default.chipRowSub,
				children: price.label
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: chip_module_css_default.chipPrice,
			children: [price.struck !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: chip_module_css_default.chipPriceWas,
				children: price.struck
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: price.current === "0.00" ? chip_module_css_default.chipPriceFree : chip_module_css_default.chipPriceNow,
				children: price.current
			})]
		})]
	});
}
/** A lane of models, summarised when it is longer than the panel can show. */
function Lane({ title, rows }) {
	const shown = rows.slice(0, ROWS_PER_LANE);
	const rest = rows.length - shown.length;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: chip_module_css_default.chipGroupLabel,
			children: [
				title,
				" · ",
				rows.length
			]
		}),
		shown.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelLine, { row }, row.id)),
		rest > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: chip_module_css_default.chipEmpty,
			children: [
				"+",
				rest,
				" more in the picker"
			]
		})
	] });
}
function WorkbuddyChip(props) {
	const { t } = props;
	const [status, setStatus] = (0, react.useState)(null);
	const [state, setState] = (0, react.useState)(null);
	const [open, setOpen] = (0, react.useState)(false);
	const rootRef = (0, react.useRef)(null);
	const panelRef = (0, react.useRef)(null);
	const apply$1 = (0, react.useCallback)((next) => {
		setStatus(next);
		setState(resolve(next));
	}, []);
	(0, react.useEffect)(() => {
		let live = true;
		const tick = () => {
			readStatus().then((read) => {
				if (live && read !== null) apply$1(read);
			});
		};
		tick();
		const timer = setInterval(tick, POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [apply$1]);
	(0, react.useEffect)(() => {
		if (!open) return;
		const onKeyDown = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open]);
	const position = (0, __deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
		open,
		anchorRef: rootRef,
		panelRef,
		side: "top",
		gap: 8,
		margin: 12
	});
	(0, __deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, panelRef);
	if (state === null) return null;
	const title = chipTitle(status ?? unreachableStub, state, t);
	const value = chipValue(state, t);
	const health = chipHealth(state);
	const pool = status?.pool;
	const spent = status?.creditsSpent ?? 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		ref: rootRef,
		className: chip_module_css_default.chipRoot,
		"data-composer-workbuddy": true,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tooltip, {
			label: title,
			side: "top",
			delayMs: 200,
			disabled: open,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: chip_module_css_default.chipTrigger,
				"data-health": health,
				"aria-label": title,
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				onClick: () => setOpen(!open),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular, {
					className: chip_module_css_default.chipIcon,
					"data-health": health,
					"aria-hidden": true
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: value })]
			})
		}), open && status !== null && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			ref: panelRef,
			className: chip_module_css_default.chipPanel,
			role: "dialog",
			"aria-label": t("chipPanelTitle"),
			style: position ?? {
				visibility: "hidden",
				left: 0,
				top: 0
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: chip_module_css_default.chipPanelHead,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: chip_module_css_default.chipPanelTitle,
						children: t("chipPanelTitle")
					}), pool !== void 0 && state.mode !== "offline" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: chip_module_css_default.chipFigures,
						children: t("chipPoolHealthy", {
							healthy: pool.healthy,
							total: pool.total
						})
					})]
				}),
				state.mode === "offline" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: chip_module_css_default.chipOfflineNote,
					children: title
				}),
				state.mode === "empty" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: chip_module_css_default.chipEmpty,
					children: t("chipEmpty")
				}),
				state.mode !== "offline" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: chip_module_css_default.chipFacts,
					children: [
						pool !== void 0 && pool.cooling > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: chip_module_css_default.chipFact,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: chip_module_css_default.chipFactValue,
								children: pool.cooling
							}), t("chipPoolCooling", { n: pool.cooling })]
						}),
						pool !== void 0 && pool.disabled > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: chip_module_css_default.chipFact,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: chip_module_css_default.chipFactValue,
								children: pool.disabled
							}), t("chipPoolDisabled", { n: pool.disabled })]
						}),
						spent > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: chip_module_css_default.chipFact,
							children: [t("chipSpent"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: chip_module_css_default.chipFactValue,
								children: spent.toFixed(2)
							})]
						})
					]
				}),
				state.mode === "ready" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [status.freeModels.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Lane, {
					title: t("chipGroupFree"),
					rows: status.freeModels
				}), status.accountModels.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Lane, {
					title: t("chipGroupAccount"),
					rows: status.accountModels
				})] }),
				status.panelUrl !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
					className: chip_module_css_default.chipPanelLink,
					href: status.panelUrl,
					target: "_blank",
					rel: "noreferrer noopener",
					children: t("chipOpenPanel")
				})
			]
		}), document.body)]
	});
}
/** A stand-in so the title can be computed before the first read lands. */
const unreachableStub = {
	reachable: false,
	error: "",
	panelUrl: "",
	pool: {
		total: 0,
		healthy: 0,
		cooling: 0,
		disabled: 0
	},
	freeModels: [],
	accountModels: [],
	creditsSpent: 0,
	at: 0
};

//#endregion
//#region src/client/locales.ts
/**
* The `settings.workbuddy2dsh` locale dictionary.
*
* ENGLISH ONLY, and deliberately so: `en` holds the key set and the key type
* is derived from it, so adding a string needs one edit rather than two. The
* host's locale contract requires a `zh` seat to exist, and `zh` IS `en` here —
* one set of strings, no second dictionary to drift.
*/
const en = {
	title: "WorkBuddy2API",
	description: "Your WorkBuddy account as an OpenAI-compatible gateway: free and account-metered models, pool health and credit spend, in the composer.",
	chipValueReady: "{free} free",
	chipValueEmpty: "no models",
	chipValueOffline: "not running",
	chipReady: "{free} free and {account} account model(s); {healthy}/{total} account(s) usable.",
	chipEmpty: "The gateway is running but no model is available yet. Open the panel to add your WorkBuddy account.",
	chipOffline: "The gateway is not answering",
	chipPanelTitle: "WorkBuddy gateway",
	chipOpenPanel: "Open management panel",
	chipPoolTitle: "Account pool",
	chipPoolHealthy: "{healthy}/{total} usable",
	chipPoolCooling: "{n} cooling",
	chipPoolDisabled: "{n} disabled",
	chipSpent: "Credits spent",
	chipGroupFree: "Free now",
	chipGroupAccount: "Account-metered",
	chipColPrice: "Price",
	chipNoModels: "No models advertised",
	chipRetry: "Retry"
};
/** The `zh` seat the host's locale contract requires. */
const zh = en;

//#endregion
//#region src/client/index.ts
/** Dictionary namespace owned by this plugin. */
const NS = "settings.workbuddy2dsh";
/** Where this sorts in the dock row: beside the ContextMeter, not over it. */
const ORDER = 20;
/**
* Required services (cordis fiber inject).
*
* `slots` to register the dock entry, `locale` for the chip's copy. Both are
* stable services, so they gate the main fiber directly.
*/
const inject = ["slots", "locale"];
/** Mount the chip. @param ctx - the browser plugin context. */
function apply(ctx) {
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "workbuddy2dsh: chip copy");
	const slots = ctx.slots;
	ctx.effect(() => slots.inject("conversation.composer.dock", () => slots.register({
		name: "conversation.composer.dock",
		id: "workbuddy2dsh-gateway",
		order: ORDER,
		locale: NS,
		label: () => t("title")
	}, WorkbuddyChip)), "workbuddy2dsh: gateway chip");
}

//#endregion
exports.NS = NS;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map