import type { PrState } from "@/components/pr-row";
import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GroupBy = "none" | "repo" | "author";
export type SortKey = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "title";
export type LabelState = "include" | "exclude";
export type PrScope = "review-requested" | "created" | "involved";
export type CiFilter = "failing" | "not-failing";

export interface PrFilterSnapshot {
  scope: PrScope;
  query: string;
  sort: SortKey;
  groupBy: GroupBy;
  labelStates: Record<string, LabelState>;
  repos: string[];
  authors: string[];
  states: PrState[];
  ciStatus?: CiFilter | null;
  ciFailing?: boolean;
}

export interface PrFilterGroup {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  filters: PrFilterSnapshot;
}

interface State {
  /** Which PRs the list fetches: awaiting your review, authored, or involved. */
  scope: PrScope;
  setScope: (s: PrScope) => void;
  query: string;
  sort: SortKey;
  groupBy: GroupBy;
  /** label name → include/exclude (absent = ignored). */
  labelStates: Record<string, LabelState>;
  repos: string[];
  authors: string[];
  states: PrState[];
  ciStatus: CiFilter | null;
  ciFailing: boolean;
  filterGroups: PrFilterGroup[];
  /** Last list scrollTop, keyed by list scope (watchedKey or scope) so each queue restores its own position. */
  scrollPos: Record<string, number>;

  setQuery: (q: string) => void;
  setScrollPos: (key: string, top: number) => void;
  setSort: (s: SortKey) => void;
  setGroupBy: (g: GroupBy) => void;
  toggleRepo: (repo: string) => void;
  clearRepos: () => void;
  toggleAuthor: (author: string) => void;
  clearAuthors: () => void;
  cycleLabel: (name: string) => void;
  clearLabels: () => void;
  toggleState: (s: PrState) => void;
  clearStates: () => void;
  setCiStatus: (status: CiFilter | null) => void;
  toggleCiFailing: () => void;
  saveFilterGroup: (name: string, filters: PrFilterSnapshot) => void;
  applyFilterGroup: (id: string) => void;
  renameFilterGroup: (id: string, name: string) => void;
  updateFilterGroup: (id: string, filters: PrFilterSnapshot) => void;
  deleteFilterGroup: (id: string) => void;
}

const toggle = <T>(arr: T[], v: T): T[] =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const cloneSnapshot = (filters: PrFilterSnapshot): PrFilterSnapshot => {
  const ciStatus = filters.ciStatus ?? (filters.ciFailing ? "failing" : null);
  return {
    ...filters,
    labelStates: { ...filters.labelStates },
    repos: [...filters.repos],
    authors: [...filters.authors],
    states: [...filters.states],
    ciStatus,
    ciFailing: ciStatus === "failing",
  };
};

export const usePrFilters = create<State>()(
  persist(
    (set, get) => ({
      scope: "review-requested",
      setScope: (scope) => set({ scope }),
      query: "",
      sort: "updated-desc",
      groupBy: "none",
      labelStates: {},
      repos: [],
      authors: [],
      states: [],
      ciStatus: null,
      ciFailing: false,
      filterGroups: [],
      scrollPos: {},

      setQuery: (query) => set({ query }),
      setScrollPos: (key, top) => set({ scrollPos: { ...get().scrollPos, [key]: top } }),
      setSort: (sort) => set({ sort }),
      setGroupBy: (groupBy) => set({ groupBy }),
      toggleRepo: (repo) => set({ repos: toggle(get().repos, repo) }),
      clearRepos: () => set({ repos: [] }),
      toggleAuthor: (author) => set({ authors: toggle(get().authors, author) }),
      clearAuthors: () => set({ authors: [] }),
      cycleLabel: (name) => {
        const next = { ...get().labelStates };
        if (!next[name]) next[name] = "include";
        else if (next[name] === "include") next[name] = "exclude";
        else delete next[name];
        set({ labelStates: next });
      },
      clearLabels: () => set({ labelStates: {} }),
      toggleState: (s) => set({ states: toggle(get().states, s) }),
      clearStates: () => set({ states: [] }),
      setCiStatus: (ciStatus) => set({ ciStatus, ciFailing: ciStatus === "failing" }),
      toggleCiFailing: () => {
        const next =
          (get().ciStatus ?? (get().ciFailing ? "failing" : null)) === "failing" ? null : "failing";
        set({ ciStatus: next, ciFailing: next === "failing" });
      },
      saveFilterGroup: (name, filters) => {
        const now = Date.now();
        set({
          filterGroups: [
            ...get().filterGroups,
            {
              id: makeId(),
              name,
              createdAt: now,
              updatedAt: now,
              filters: cloneSnapshot(filters),
            },
          ],
        });
      },
      applyFilterGroup: (id) => {
        const group = get().filterGroups.find((g) => g.id === id);
        if (!group) return;
        set(cloneSnapshot(group.filters));
      },
      renameFilterGroup: (id, name) =>
        set({
          filterGroups: get().filterGroups.map((group) =>
            group.id === id ? { ...group, name, updatedAt: Date.now() } : group,
          ),
        }),
      updateFilterGroup: (id, filters) =>
        set({
          filterGroups: get().filterGroups.map((group) =>
            group.id === id
              ? { ...group, filters: cloneSnapshot(filters), updatedAt: Date.now() }
              : group,
          ),
        }),
      deleteFilterGroup: (id) =>
        set({ filterGroups: get().filterGroups.filter((group) => group.id !== id) }),
    }),
    { name: "reviewly.pr-filters", storage: sqlStorage<State>() },
  ),
);
