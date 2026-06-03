---
publish: false
---
# NextVersion

- [NextVersion](#nextversion)
  - [@itwin/core-backend](#itwincore-backend)
    - [Move elements between models and parents](#move-elements-between-models-and-parents)
    - [ECSQL CROSS JOIN now supports optional ON clause](#ecsql-cross-join-now-supports-optional-on-clause)
    - [Schema changesets can be reversed](#schema-changesets-can-be-reversed)
  - [@itwin/map-layers-formats](#itwinmap-layers-formats)
    - [Azure Maps basemap support is available through map-layers-formats](#azure-maps-basemap-support-is-available-through-map-layers-formats)
  - [Electron 42 support](#electron-42-support)

## @itwin/core-backend

### Move elements between models and parents

New `@beta` methods allow moving existing elements to a different model and/or parent without deleting and re-inserting them:

- **`EditTxn.changeElementParent`** — changes the parent of a single leaf element (no children). If the new parent is in a different model, the element's model changes as well.
- **`EditTxn.changeElementModel`** — changes the model of a single leaf element, making it a root element (no parent) in the new model.
- **`IModelDb.Elements.changeElementParent`** — recursively reparents an element and its entire descendant subtree (assembly-safe). Wrapped in a transaction for atomicity.
- **`IModelDb.Elements.changeElementModel`** — recursively moves an element and its entire descendant subtree to a new model (assembly-safe). Wrapped in a transaction for atomicity.

The `EditTxn` methods operate on leaf elements only. For assemblies (elements with children), use the `IModelDb.Elements` methods which handle the subtree recursively.

`EditTxn.changeElementParent` accepts [ChangeElementParentProps]($backend) (element id and new parent id). `EditTxn.changeElementModel` accepts [ChangeElementModelProps]($backend) (element id and target model id). The `IModelDb.Elements` methods accept the same props but handle the entire subtree atomically.

**Blocked code scopes**: Elements with `Model`-scoped or `ParentElement`-scoped codes cannot be moved — the operation will throw with `InvalidCode`. Elements with `Repository`-scoped, `RelatedElement`-scoped, or empty codes are allowed.

```typescript
// Change a leaf element's parent (stays in same model if parent is in same model)
editTxn.changeElementParent({ id: elementId, parentId: newParentId });

// Move a leaf element to a different model as a root element (clears parent)
editTxn.changeElementModel({ id: elementId, modelId: newModelId });

// Reparent an assembly (element with children) — subtree follows
iModelDb.elements.changeElementParent({ id: assemblyId, parentId: newParentId });

// Move an assembly to a different model — subtree follows
iModelDb.elements.changeElementModel({ id: assemblyId, modelId: newModelId });
```

### ECSQL CROSS JOIN now supports optional ON clause

`CROSS JOIN` in ECSQL now accepts an optional `ON` condition, matching standard SQL and SQLite behavior. Previously, `CROSS JOIN` only produced an unfiltered Cartesian product between two classes.

The key benefit of using `CROSS JOIN` with an `ON` clause — rather than `INNER JOIN` — is optimizer control: SQLite's [special CROSS JOIN handling](https://www.sqlite.org/lang_select.html#special_handling_of_cross_join_) prevents the query planner from reordering the joined tables, giving applications explicit control over the join order and query execution plan.

**Example** — filter the Cartesian product while locking join order:

```sql
-- Returns only matching Person/Identifier pairs, but forces Person to be the outer table
SELECT * FROM ts.Person p CROSS JOIN ts.Identifier i ON p.PersonalID = i.PersonId
```

This is equivalent in result to an `INNER JOIN`, but the optimizer is not permitted to swap the table order, which can be important for performance-sensitive queries.

### Schema changesets can be reversed

This makes it possible to walk a changeset timeline backwards through interleaved schema and data changesets. After reversing a schema changeset, the EC metadata (class definitions, property mappings, schema version) reflects the state prior to that changeset.

As a result, `CheckpointManager.downloadCheckpoint` now succeeds when the target changeset is older than the checkpoint and the range spans one or more schema changesets. Previously this would fail because schema changesets could not be reversed.

## @itwin/map-layers-formats

### Azure Maps basemap support is available through map-layers-formats

`@itwin/map-layers-formats` now registers Azure Maps imagery support through `MapLayersFormats.initialize()` and exposes a beta `AzureMaps` helper for applying Azure Maps Street, Aerial, and Hybrid basemaps.

Applications configure the Azure Maps key when initializing `@itwin/map-layers-formats` with `MapLayersFormats.initialize({ azureMapsOpts: { subscriptionKey: ... } })`. After initializing `@itwin/map-layers-formats`, code that wants Azure-specific basemap helpers can import `AzureMaps` from that package.

## Electron 42 support

In addition to [already supported Electron versions](../learning/SupportedPlatforms.md#electron), iTwin.js now supports [Electron 42](https://www.electronjs.org/blog/electron-42-0).
