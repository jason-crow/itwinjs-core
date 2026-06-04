/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import { assert } from "chai";
import * as path from "path";
import { Guid, OpenMode } from "@itwin/core-bentley";
import { Code, ColorByName, DomainOptions, ElementGeometry, ElementGeometryBuilderParams, GeometricElement3dProps, GeometryStreamBuilder, IModel, SubCategoryAppearance, UpgradeOptions } from "@itwin/core-common";
import { LineSegment3d, LineString3d, Point3d, Transform, YawPitchRollAngles } from "@itwin/core-geometry";
import {
  _nativeDb, ChannelControl, EditTxn, GeometricElement, IModelDb, IModelHost, IModelJsFs, PhysicalModel, PhysicalPartition, SpatialCategory,
  StandaloneDb, SubCategory, SubjectOwnsPartitionElements, withEditTxn,
} from "../../core-backend";
import { OnElementPropsArg } from "../../Element";
import { IModelTestUtils, TestPhysicalObject, TestPhysicalObjectProps } from "../IModelTestUtils";
import { IModelNative } from "../../internal/NativePlatform";

/**
 * Reproduces a regression between iTwin.js 5.8.2 and 5.9.4 where element properties
 * modified by a domain handler's `onUpdate()` callback are not visible to subsequent
 * `getElement()` calls within the same EditTxn scope (without intermediate `saveChanges`).
 *
 * The scenario simulates `BasicManipulationCommand` (EditBuiltInCommand.ts):
 *   1. `updateGeometricElement()` → DomainHandler `onUpdate()` modifies props
 *   2. `transformPlacement()` → `getElement()` should return the handler-modified props
 *
 * Root cause: In 5.9.4, `BasicManipulationCommand` was changed to use `EditTxn.updateElement()`
 * (commit 5e6c6884d3). The domain handler pattern (like OpenSitePlus Draft.ts) calls
 * `iModel.elements.getElementProps()` INSIDE `onUpdate` to read current state, which
 * re-populates the element cache with OLD data. After native persists the modified props,
 * `Element.onUpdated()` must properly clear this stale cache entry so that subsequent
 * reads return the handler-modified data.
 *
 * @see https://github.com/iTwin/itwinjs-core/blob/master/editor/backend/src/EditBuiltInCommand.ts
 * @see https://github.com/iTwin/OpenSitePlus/blob/0f11b8cc/packages/drafting-tools-backend/src/domain-handlers/Draft.ts
 */
describe.only("Element update with onUpdate handler", () => {
  before(async () => {
    await IModelHost.startup({ cacheDir: path.join(__dirname, ".cache") });
  });

  after(async () => {
    await IModelHost.shutdown();
  });
  let imodel: StandaloneDb;
  let testFileName: string;
  let modelId: string;
  let categoryId: string;

  const handlerLabel = "modified_by_onUpdate_handler";
  let onUpdateCallCount = 0;
  let propsReceivedByOnUpdate: GeometricElement3dProps[] = [];

  // Save original onUpdate so we can restore it
  const originalOnUpdate = (TestPhysicalObject as any).onUpdate;

  const performUpgrade = (pathname: string) => {
    const nativeDb = new IModelNative.platform.DgnDb();
    const upgradeOptions: UpgradeOptions = {
      domain: DomainOptions.Upgrade,
      schemaLockHeld: true,
    };
    nativeDb.openIModel(pathname, OpenMode.ReadWrite, upgradeOptions);
    nativeDb.deleteAllTxns();
    nativeDb.closeFile();
  };

  beforeEach(async () => {
    onUpdateCallCount = 0;
    propsReceivedByOnUpdate = [];

    IModelTestUtils.registerTestBimSchema();

    testFileName = IModelTestUtils.prepareOutputFile("ElementUpdateHandler", `${Guid.createValue()}.bim`);
    const seedFileName = IModelTestUtils.resolveAssetFile("test.bim");
    const schemaFileName = IModelTestUtils.resolveAssetFile("TestBim.ecschema.xml");
    IModelJsFs.copySync(seedFileName, testFileName);
    performUpgrade(testFileName);
    imodel = StandaloneDb.openFile(testFileName, OpenMode.ReadWrite);
    await imodel.importSchemas([schemaFileName]);
    imodel.channels.addAllowedChannel(ChannelControl.sharedChannelName);

    // Create model and category within an EditTxn
    withEditTxn(imodel, "setup", (txn) => {
      const partition = imodel.elements.createElement({
        classFullName: PhysicalPartition.classFullName,
        parent: new SubjectOwnsPartitionElements(IModel.rootSubjectId),
        model: IModel.repositoryModelId,
        code: PhysicalPartition.createCode(imodel, IModel.rootSubjectId, "TestModel"),
      });
      const partitionId = txn.insertElement(partition.toJSON());
      const model = imodel.models.createModel({
        modeledElement: { id: partitionId },
        classFullName: PhysicalModel.classFullName,
      });
      modelId = txn.insertModel(model.toJSON());

      const category = SpatialCategory.create(imodel, IModel.dictionaryId, "TestCategory");
      categoryId = txn.insertElement(category.toJSON());
      const subCat = imodel.elements.getElement<SubCategory>(IModelDb.getDefaultSubCategoryId(categoryId));
      subCat.appearance = new SubCategoryAppearance({ color: ColorByName.darkRed });
      txn.updateElement(subCat.toJSON());
    });

    imodel[_nativeDb].deleteAllTxns();
  });

  afterEach(() => {
    // Restore original onUpdate
    if (originalOnUpdate) {
      (TestPhysicalObject as any).onUpdate = originalOnUpdate;
    } else {
      delete (TestPhysicalObject as any).onUpdate;
    }

    if (imodel.isOpen)
      imodel.close();

    IModelJsFs.removeSync(testFileName);
  });

  function makeElementProps(): TestPhysicalObjectProps {
    const builder = new GeometryStreamBuilder();
    builder.appendGeometry(LineSegment3d.create(Point3d.createZero(), Point3d.create(5, 0, 0)));
    return {
      classFullName: "TestBim:TestPhysicalObject",
      model: modelId,
      category: categoryId,
      code: Code.createEmpty(),
      intProperty: 100,
      userLabel: "original_label",
      placement: {
        origin: new Point3d(1, 2, 0),
        angles: new YawPitchRollAngles(),
      },
      geom: builder.geometryStream,
    };
  }

  /**
   * Installs a simple onUpdate handler that directly modifies arg.props.
   */
  function installSimpleHandler() {
    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      propsReceivedByOnUpdate.push(JSON.parse(JSON.stringify(arg.props)) as GeometricElement3dProps);
      arg.props.userLabel = handlerLabel;
      onUpdateCallCount++;
    };
  }

  /**
   * Installs an onUpdate handler that mimics the Draft.ts pattern from OpenSitePlus:
   * - Reads the current element props from the DB inside onUpdate (causes cache re-population)
   * - Merges current + updated props
   * - Modifies the updated props based on the merge
   *
   * This pattern triggers the cache poisoning bug because getElementProps() re-fills the
   * cache with OLD data during the onUpdate callback (before native has persisted changes).
   */
  function installDraftStyleHandler() {
    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      const updatedProps = arg.props as Partial<GeometricElement3dProps>;

      // This is the critical pattern from Draft.ts:
      // Reading element props from DB inside onUpdate re-populates the element cache
      // with the OLD (pre-update) data because native hasn't committed yet.
      const currentProps = arg.iModel.elements.getElementProps<GeometricElement3dProps>(updatedProps.id ?? "");

      propsReceivedByOnUpdate.push(JSON.parse(JSON.stringify(updatedProps)) as GeometricElement3dProps);

      // Simulate Draft.updatePlacement: if placement wasn't changed by caller,
      // derive it from currentProps placement + custom property logic
      if (updatedProps.placement === undefined) {
        updatedProps.placement = currentProps.placement;
      }

      // Simulate propsFromPlacement: sync a custom property from the placement
      // (Many domain handlers store derived data in userLabel or jsonProperties)
      arg.props.userLabel = handlerLabel;

      // Simulate updating jsonProperties based on merge of current + updated
      if (!arg.props.jsonProperties)
        arg.props.jsonProperties = {};
      arg.props.jsonProperties.draftHandler = {
        wasProcessed: true,
        updateCount: (currentProps.jsonProperties?.draftHandler?.updateCount ?? 0) + 1,
      };

      onUpdateCallCount++;
    };
  }

  it("getElement should return props modified by onUpdate handler after first update", async () => {
    installSimpleHandler();

    await withEditTxn(imodel, "test update", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      propsReceivedByOnUpdate = [];

      // First update: change intProperty. onUpdate handler will also set userLabel.
      const element = imodel.elements.getElement<TestPhysicalObject>(elementId);
      assert.equal(element.userLabel, "original_label", "userLabel should start as original");

      element.intProperty = 200;
      element.userLabel = "caller_set_before_update";
      txn.updateElement(element.toJSON());
      txn.saveChanges("first update");

      assert.equal(onUpdateCallCount, 1, "onUpdate should have been called once");

      // Read element back - should reflect onUpdate modification
      const afterFirstUpdate = imodel.elements.getElement<TestPhysicalObject>(elementId);
      assert.equal(afterFirstUpdate.userLabel, handlerLabel,
        "After first update, getElement should return the userLabel set by onUpdate handler");
      assert.equal(afterFirstUpdate.intProperty, 200,
        "intProperty should reflect the caller's direct modification");
    });
  });

  it("without saveChanges between updates (exact BasicManipulationCommand flow)", async () => {
    // This is the EXACT scenario from the bug report:
    // 1. updateGeometricElement() -> onUpdate modifies props -> NO saveChanges
    // 2. transformPlacement() -> getElement() -> modify placement -> updateElement() -> onUpdate
    // The second onUpdate should see the modifications from the first onUpdate.
    installSimpleHandler();

    await withEditTxn(imodel, "test no-save between updates", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      propsReceivedByOnUpdate = [];

      // --- Step 1: Simulate updateGeometricElement() ---
      const elementForFirstUpdate = imodel.elements.getElement<TestPhysicalObject>(elementId);
      elementForFirstUpdate.intProperty = 200;
      txn.updateElement(elementForFirstUpdate.toJSON());
      // NOTE: No saveChanges() here! This is the key difference.

      assert.equal(onUpdateCallCount, 1, "onUpdate called once after first update");

      // --- Step 2: Simulate transformPlacement() ---
      // Read element back WITHOUT saveChanges first (as transformPlacement does)
      const elementForPlacement = imodel.elements.getElement<GeometricElement>(elementId);

      // THIS IS THE KEY ASSERTION: getElement must return the onUpdate-modified props
      // even though saveChanges was NOT called between the two operations.
      assert.equal(elementForPlacement.userLabel, handlerLabel,
        "BUG REPRODUCTION: getElement after updateElement (without saveChanges) should still return " +
        "the userLabel modified by onUpdate handler. If this fails, it confirms the reported regression " +
        "where transformPlacement receives stale props after updateGeometricElement.");

      // Modify placement (as transformPlacement does)
      const transform = Transform.createTranslationXYZ(10, 20, 0);
      elementForPlacement.placement.multiplyTransform(transform);

      // Second update (as transformPlacement does)
      txn.updateElement(elementForPlacement.toJSON());

      assert.equal(onUpdateCallCount, 2, "onUpdate called twice total");

      // Verify that the second onUpdate received the props with the first handler's modifications
      assert.equal(propsReceivedByOnUpdate[1].userLabel, handlerLabel,
        "Second onUpdate should receive props with userLabel set by first onUpdate handler " +
        "(even without saveChanges between the two updates).");

      // Now save and verify final state
      txn.saveChanges("both updates saved");

      const finalElement = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(finalElement.userLabel, handlerLabel,
        "Final element should have userLabel from onUpdate handler");
      assert.approximately(finalElement.placement.origin.x, 11, 0.001, "placement origin.x should reflect transform");
      assert.approximately(finalElement.placement.origin.y, 22, 0.001, "placement origin.y should reflect transform");
    });
  });

  it("Draft-style handler: getElementProps inside onUpdate should not poison cache (no saveChanges between updates)", async () => {
    // This test replicates the exact pattern from OpenSitePlus Draft.ts:
    // The onUpdate handler calls iModel.elements.getElementProps() to read current state,
    // which RE-POPULATES the element cache with OLD data (since native hasn't persisted yet).
    // After native persists, Element.onUpdated() must clear this stale cache entry.
    // Then the next getElement() call must read fresh data from native.
    //
    // In 5.9.4 this was broken: the stale cache entry from the handler's getElementProps
    // was NOT properly cleared, causing transformPlacement to read old props.
    installDraftStyleHandler();

    await withEditTxn(imodel, "test draft-style handler", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      propsReceivedByOnUpdate = [];

      // --- Step 1: Simulate BasicManipulationCommand.updateGeometricElement() ---
      const elementForFirstUpdate = imodel.elements.getElement<TestPhysicalObject>(elementId);
      elementForFirstUpdate.intProperty = 200;
      txn.updateElement(elementForFirstUpdate.toJSON());
      // NO saveChanges - mirrors the actual BasicManipulationCommand flow

      assert.equal(onUpdateCallCount, 1, "onUpdate called once");

      // --- Step 2: Simulate BasicManipulationCommand.transformPlacement() ---
      // This getElement call is the critical one:
      // - The draft-style handler called getElementProps INSIDE onUpdate, caching OLD data
      // - Element.onUpdated should have cleared that stale cache entry
      // - Now readInstance should fetch fresh (handler-modified) data from native
      const elementForPlacement = imodel.elements.getElement<GeometricElement>(elementId);

      // Verify that the handler's modifications from step 1 are visible
      assert.equal(elementForPlacement.userLabel, handlerLabel,
        "REGRESSION TEST: After draft-style handler modified props during onUpdate, " +
        "subsequent getElement must return the modified props. " +
        "Failure indicates the element cache was poisoned by getElementProps called inside onUpdate.");

      // Verify jsonProperties were set by the handler
      const jsonProps = (elementForPlacement as any).jsonProperties;
      assert.isDefined(jsonProps?.draftHandler, "jsonProperties.draftHandler should be set by handler");
      assert.equal(jsonProps?.draftHandler?.wasProcessed, true,
        "draftHandler.wasProcessed should be true");
      assert.equal(jsonProps?.draftHandler?.updateCount, 1,
        "draftHandler.updateCount should be 1 after first update");

      // Modify placement (as transformPlacement does)
      const transform = Transform.createTranslationXYZ(10, 20, 0);
      elementForPlacement.placement.multiplyTransform(transform);

      // Second update (as transformPlacement does)
      txn.updateElement(elementForPlacement.toJSON());

      assert.equal(onUpdateCallCount, 2, "onUpdate called twice total");

      // Verify the second handler call saw the first handler's modifications
      assert.equal(propsReceivedByOnUpdate[1].userLabel, handlerLabel,
        "Second onUpdate should see userLabel from first handler");
      assert.equal((propsReceivedByOnUpdate[1] as any).jsonProperties?.draftHandler?.updateCount, 1,
        "Second onUpdate should see updateCount=1 from first handler");

      txn.saveChanges("both updates saved");

      // Verify final persisted state
      const finalElement = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(finalElement.userLabel, handlerLabel,
        "Final element should have userLabel from handler");
      assert.equal((finalElement as any).jsonProperties?.draftHandler?.updateCount, 2,
        "Final updateCount should be 2 (incremented by each handler call)");
      assert.approximately(finalElement.placement.origin.x, 11, 0.001, "placement x should reflect transform");
      assert.approximately(finalElement.placement.origin.y, 22, 0.001, "placement y should reflect transform");
    });
  });

  it("Draft-style handler: multiple updates without saveChanges should chain correctly", async () => {
    // Extended scenario: 3 sequential updates without saveChanges.
    // Each handler reads current props from DB and modifies them.
    // Each subsequent getElement must see all prior handler modifications.
    installDraftStyleHandler();

    await withEditTxn(imodel, "test chained updates", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      propsReceivedByOnUpdate = [];

      // Update 1: change intProperty
      const el1 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el1.intProperty = 200;
      txn.updateElement(el1.toJSON());

      assert.equal(onUpdateCallCount, 1);

      // Update 2: transform placement (no saveChanges between)
      const el2 = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(el2.userLabel, handlerLabel,
        "After update 1, getElement should return handler-modified props");
      assert.equal((el2 as any).jsonProperties?.draftHandler?.updateCount, 1,
        "updateCount should be 1 after first update");

      el2.placement.multiplyTransform(Transform.createTranslationXYZ(5, 0, 0));
      txn.updateElement(el2.toJSON());

      assert.equal(onUpdateCallCount, 2);

      // Update 3: another property change (no saveChanges between)
      const el3 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      assert.equal(el3.userLabel, handlerLabel,
        "After update 2, getElement should still return handler-modified props");
      assert.equal((el3 as any).jsonProperties?.draftHandler?.updateCount, 2,
        "updateCount should be 2 after second update");
      assert.approximately(el3.placement.origin.x, 6, 0.001,
        "placement.x should be 1+5=6 after first transform");

      el3.intProperty = 300;
      txn.updateElement(el3.toJSON());

      assert.equal(onUpdateCallCount, 3);

      // Final read
      txn.saveChanges("all updates");
      const finalEl = imodel.elements.getElement<TestPhysicalObject>(elementId);
      assert.equal(finalEl.userLabel, handlerLabel);
      assert.equal((finalEl as any).jsonProperties?.draftHandler?.updateCount, 3,
        "Final updateCount should be 3");
      assert.equal(finalEl.intProperty, 300);
      assert.approximately(finalEl.placement.origin.x, 6, 0.001);
    });
  });

  it("Draft-style handler: second onUpdate receives current DB state (not stale cache)", async () => {
    // Verifies that within the second onUpdate callback, calling getElementProps
    // returns the state AFTER the first update (not the original pre-update state).
    // This is the core of the Draft.ts pattern where each handler call needs to
    // see the cumulative state of prior updates.
    let currentPropsSeenByHandler: GeometricElement3dProps[] = [];

    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      const updatedProps = arg.props as Partial<GeometricElement3dProps>;

      // Read current state from DB (Draft.ts pattern)
      const currentProps = arg.iModel.elements.getElementProps<GeometricElement3dProps>(updatedProps.id ?? "");
      currentPropsSeenByHandler.push(JSON.parse(JSON.stringify(currentProps)));

      // Modify the props being saved
      arg.props.userLabel = `handler_${onUpdateCallCount + 1}`;
      if (!arg.props.jsonProperties)
        arg.props.jsonProperties = {};
      arg.props.jsonProperties.handlerVersion = onUpdateCallCount + 1;
      onUpdateCallCount++;
    };

    await withEditTxn(imodel, "test handler sees DB state", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      currentPropsSeenByHandler = [];

      // First update
      const el1 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el1.intProperty = 200;
      txn.updateElement(el1.toJSON());
      // No saveChanges

      // Verify first handler saw original state
      assert.equal(currentPropsSeenByHandler[0].userLabel, "original_label",
        "First onUpdate handler should see original DB state (update hasn't persisted yet)");

      // Second update
      const el2 = imodel.elements.getElement<GeometricElement>(elementId);
      el2.placement.multiplyTransform(Transform.createTranslationXYZ(10, 0, 0));
      txn.updateElement(el2.toJSON());

      // KEY ASSERTION: The second handler's getElementProps should see the
      // state AFTER the first update (with handler_1 modifications)
      assert.equal(currentPropsSeenByHandler[1].userLabel, "handler_1",
        "REGRESSION TEST: Second onUpdate handler's getElementProps must return " +
        "the state after first update (including first handler's modifications). " +
        "If this fails, readInstance is not seeing uncommitted writes from the first updateElement.");
      assert.equal(currentPropsSeenByHandler[1].jsonProperties?.handlerVersion, 1,
        "Second handler should see jsonProperties.handlerVersion=1 from first handler");

      txn.saveChanges("done");

      const finalEl = imodel.elements.getElement<TestPhysicalObject>(elementId);
      assert.equal(finalEl.userLabel, "handler_2");
      assert.equal((finalEl as any).jsonProperties?.handlerVersion, 2);
    });
  });

  it("Draft-style handler with elementGeometryBuilderParams: geometry modification in onUpdate should persist correctly", async () => {
    // This test exercises the EXACT code path the Draft.ts handler uses:
    // The onUpdate handler builds NEW geometry using ElementGeometry.Builder and sets
    // `elementGeometryBuilderParams` on arg.props. This triggers the native
    // GeometricElement::_FromJson early-return path (BuildGeometryStream) which is
    // different from the normal geom/geomBinary path.
    //
    // The Draft handler pattern:
    //   1. Read current element props from DB
    //   2. Build new geometry based on modified placement (e.g., line from bearing/length)
    //   3. Set arg.props.elementGeometryBuilderParams = { entryArray: builder.entries }
    //   4. Set arg.props.placement with new origin/angles
    //
    // After the first update, the second getElement() call (for transformPlacement)
    // must return the handler-modified placement and the correct geometry.

    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      const updatedProps = arg.props as Partial<GeometricElement3dProps>;

      // Read current state from DB (Draft.ts pattern)
      const currentProps = arg.iModel.elements.getElementProps<GeometricElement3dProps>(updatedProps.id ?? "");

      propsReceivedByOnUpdate.push(JSON.parse(JSON.stringify(updatedProps)) as GeometricElement3dProps);

      // Simulate Draft.updateGeometry: build new geometry using ElementGeometry.Builder
      // The Draft handler computes a line segment from bearing/length and builds new geometry
      const newOrigin = new Point3d(10, 20, 0);
      const endPoint = new Point3d(10 + (onUpdateCallCount + 1) * 5, 20, 0);

      const geomBuilder = new ElementGeometry.Builder();
      geomBuilder.appendGeometryQuery(LineSegment3d.create(Point3d.createZero(), endPoint.minus(newOrigin)));

      // Set elementGeometryBuilderParams - this is the key Draft.ts pattern
      // This triggers the native BuildGeometryStream path in GeometricElement::_FromJson
      (arg.props as any).elementGeometryBuilderParams = { entryArray: geomBuilder.entries } as ElementGeometryBuilderParams;

      // Set the new placement (origin + angles)
      // In the BuildGeometryStream path, only origin and angles are used from placement
      // (bbox is computed from the geometry)
      (arg.props as any).placement = {
        origin: newOrigin,
        angles: { yaw: 0, pitch: 0, roll: 0 },
      };

      // Also modify userLabel to track handler execution
      arg.props.userLabel = `geom_handler_${onUpdateCallCount + 1}`;

      if (!arg.props.jsonProperties)
        arg.props.jsonProperties = {};
      arg.props.jsonProperties.draftHandler = {
        updateCount: (currentProps.jsonProperties?.draftHandler?.updateCount ?? 0) + 1,
        geometryLength: (onUpdateCallCount + 1) * 5,
      };

      onUpdateCallCount++;
    };

    await withEditTxn(imodel, "test elementGeometryBuilderParams in handler", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      propsReceivedByOnUpdate = [];

      // --- Step 1: Simulate BasicManipulationCommand.updateGeometricElement() ---
      const elementForFirstUpdate = imodel.elements.getElement<TestPhysicalObject>(elementId);
      elementForFirstUpdate.intProperty = 200;
      txn.updateElement(elementForFirstUpdate.toJSON());
      // NO saveChanges - mirrors actual BasicManipulationCommand flow

      assert.equal(onUpdateCallCount, 1, "onUpdate should be called once");

      // --- Step 2: Simulate BasicManipulationCommand.transformPlacement() ---
      // This getElement must return the handler-modified state (including geometry changes)
      const elementForPlacement = imodel.elements.getElement<GeometricElement>(elementId);

      // Verify handler-modified placement origin is visible
      assert.equal(elementForPlacement.userLabel, "geom_handler_1",
        "REGRESSION TEST (elementGeometryBuilderParams): After handler sets elementGeometryBuilderParams " +
        "and placement in onUpdate, subsequent getElement must return the handler-modified state. " +
        "Failure indicates BuildGeometryStream path doesn't properly persist or cache is stale.");

      assert.approximately(elementForPlacement.placement.origin.x, 10, 0.001,
        "Placement origin.x should be 10 (set by handler via elementGeometryBuilderParams path)");
      assert.approximately(elementForPlacement.placement.origin.y, 20, 0.001,
        "Placement origin.y should be 20 (set by handler via elementGeometryBuilderParams path)");

      // Verify jsonProperties were set by handler
      const jsonProps = (elementForPlacement as any).jsonProperties;
      assert.isDefined(jsonProps?.draftHandler, "draftHandler should be set");
      assert.equal(jsonProps?.draftHandler?.updateCount, 1, "updateCount should be 1");
      assert.equal(jsonProps?.draftHandler?.geometryLength, 5, "geometryLength should be 5");

      // Now do the second update (transform placement)
      const transform = Transform.createTranslationXYZ(5, 10, 0);
      elementForPlacement.placement.multiplyTransform(transform);
      txn.updateElement(elementForPlacement.toJSON());

      assert.equal(onUpdateCallCount, 2, "onUpdate should be called twice");

      // The second handler received the element state AFTER first handler's modifications
      assert.equal(propsReceivedByOnUpdate[1].userLabel, "geom_handler_1",
        "Second onUpdate should receive props with userLabel from first handler");

      txn.saveChanges("both updates done");

      // Final verification
      const finalEl = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(finalEl.userLabel, "geom_handler_2",
        "Final element should have userLabel from second handler invocation");
      assert.equal((finalEl as any).jsonProperties?.draftHandler?.updateCount, 2,
        "Final updateCount should be 2");
      // The second handler overwrites placement to origin(10,20,0), not the transformed one
      assert.approximately(finalEl.placement.origin.x, 10, 0.001,
        "Final origin.x should be 10 (handler always sets origin to 10,20,0)");
      assert.approximately(finalEl.placement.origin.y, 20, 0.001,
        "Final origin.y should be 20 (handler always sets origin to 10,20,0)");
    });
  });

  it("Draft-style handler with elementGeometryBuilderParams: geometry varies per update (line length changes)", async () => {
    // More realistic Draft scenario: Each update changes a "length" property,
    // and the handler builds geometry (a line segment) whose length corresponds
    // to that property. After each update, reading the element back should show:
    //   - The handler-set placement
    //   - The correct bounding box (derived from the handler-built geometry)
    //   - The handler-set custom properties
    //
    // This specifically tests that BuildGeometryStream correctly computes the bbox
    // from the handler-provided geometry, and that this bbox is properly persisted
    // and readable via readInstance.

    const lineOrigin = new Point3d(0, 0, 0);

    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      const updatedProps = arg.props as Partial<GeometricElement3dProps>;

      // Read current state (Draft pattern)
      arg.iModel.elements.getElementProps<GeometricElement3dProps>(updatedProps.id ?? "");

      // Simulate: handler uses intProperty as "length" to build a line
      const lineLength = (updatedProps as any).intProperty ?? 10;

      // Build geometry: a line from origin to (lineLength, 0, 0) in local coords
      const geomBuilder = new ElementGeometry.Builder();
      geomBuilder.appendGeometryQuery(LineSegment3d.create(Point3d.createZero(), new Point3d(lineLength, 0, 0)));

      (arg.props as any).elementGeometryBuilderParams = { entryArray: geomBuilder.entries } as ElementGeometryBuilderParams;
      (arg.props as any).placement = {
        origin: lineOrigin,
        angles: { yaw: 0, pitch: 0, roll: 0 },
      };

      arg.props.userLabel = `line_len_${lineLength}`;
      onUpdateCallCount++;
    };

    await withEditTxn(imodel, "test geometry varies per update", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;

      // First update: set intProperty = 15 → handler builds line of length 15
      const el1 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el1.intProperty = 15;
      txn.updateElement(el1.toJSON());
      // No saveChanges

      // Read back: should see handler-modified state with line length 15
      const afterFirst = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(afterFirst.userLabel, "line_len_15",
        "After first update, userLabel should reflect line length 15");
      assert.approximately(afterFirst.placement.origin.x, 0, 0.001, "origin.x should be 0");
      // Bounding box should encompass the line [0,0,0] to [15,0,0]
      assert.isTrue(afterFirst.placement.bbox.high.x >= 14.9,
        `BBox high.x should be ~15 (got ${afterFirst.placement.bbox.high.x}), ` +
        "confirming BuildGeometryStream computed correct bbox from handler geometry");

      // Second update: set intProperty = 25 → handler builds line of length 25
      const el2 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el2.intProperty = 25;
      txn.updateElement(el2.toJSON());

      txn.saveChanges("done");

      // Final read: should see line length 25
      const finalEl = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(finalEl.userLabel, "line_len_25",
        "Final userLabel should reflect line length 25");
      assert.isTrue(finalEl.placement.bbox.high.x >= 24.9,
        `Final BBox high.x should be ~25 (got ${finalEl.placement.bbox.high.x}), ` +
        "confirming second BuildGeometryStream updated bbox correctly");
    });
  });

  it("Draft-style handler with elementGeometryBuilderParams and multi-segment geometry", async () => {
    // Tests a more complex geometry scenario where the handler builds a polyline
    // (multiple points) rather than a simple line segment. This exercises the
    // native BuildGeometryStream with more complex geometry entries.

    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      const updatedProps = arg.props as Partial<GeometricElement3dProps>;

      // Read current state (Draft pattern - causes cache re-population with old data)
      arg.iModel.elements.getElementProps<GeometricElement3dProps>(updatedProps.id ?? "");

      // Build a polyline (LineString3d) with points based on intProperty
      const numSegments = (updatedProps as any).intProperty ?? 3;
      const points: Point3d[] = [];
      for (let i = 0; i <= numSegments; i++) {
        points.push(new Point3d(i * 2, i * 2, 0));
      }

      const geomBuilder = new ElementGeometry.Builder();
      geomBuilder.appendGeometryQuery(LineString3d.create(points));

      (arg.props as any).elementGeometryBuilderParams = { entryArray: geomBuilder.entries } as ElementGeometryBuilderParams;
      (arg.props as any).placement = {
        origin: new Point3d(100, 200, 0),
        angles: { yaw: 45, pitch: 0, roll: 0 },
      };

      arg.props.userLabel = `polyline_${numSegments}_segments`;
      if (!arg.props.jsonProperties)
        arg.props.jsonProperties = {};
      arg.props.jsonProperties.segmentCount = numSegments;
      onUpdateCallCount++;
    };

    await withEditTxn(imodel, "test multi-segment geometry", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;

      // First update: 4 segments
      const el1 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el1.intProperty = 4;
      txn.updateElement(el1.toJSON());
      // No saveChanges between updates

      // Read back after first update
      const afterFirst = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(afterFirst.userLabel, "polyline_4_segments",
        "REGRESSION TEST (multi-segment): After handler builds polyline geometry via " +
        "elementGeometryBuilderParams in onUpdate, getElement must return handler state. " +
        "Failure indicates BuildGeometryStream path has cache/persistence issue.");
      assert.approximately(afterFirst.placement.origin.x, 100, 0.001,
        "Placement origin.x should be 100 (handler-set)");
      assert.approximately(afterFirst.placement.origin.y, 200, 0.001,
        "Placement origin.y should be 200 (handler-set)");
      assert.equal((afterFirst as any).jsonProperties?.segmentCount, 4,
        "jsonProperties.segmentCount should be 4");

      // Second update: 6 segments (without saveChanges between)
      const el2 = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el2.intProperty = 6;
      txn.updateElement(el2.toJSON());

      assert.equal(onUpdateCallCount, 2, "Handler should have been called twice");

      txn.saveChanges("done");

      // Final state
      const finalEl = imodel.elements.getElement<GeometricElement>(elementId);
      assert.equal(finalEl.userLabel, "polyline_6_segments",
        "Final element should have polyline with 6 segments");
      assert.approximately(finalEl.placement.origin.x, 100, 0.001);
      assert.approximately(finalEl.placement.origin.y, 200, 0.001);
      assert.equal((finalEl as any).jsonProperties?.segmentCount, 6);
      // BBox should encompass polyline points [0,0,0] to [12,12,0] in local coords
      assert.isTrue(finalEl.placement.bbox.high.x >= 11.9,
        `BBox high.x should be ~12 (got ${finalEl.placement.bbox.high.x})`);
      assert.isTrue(finalEl.placement.bbox.high.y >= 11.9,
        `BBox high.y should be ~12 (got ${finalEl.placement.bbox.high.y})`);
    });
  });

  it("OpenSitePlus LineSegment pattern: handler reads wantGeometry, computes geometry from EC property, second handler sees first handler's EC prop changes", async () => {
    // This test replicates the EXACT OpenSitePlus LineSegment domain handler pattern:
    //
    // LineSegment.onUpdate → LineSegment.update(updatedProps, iModel):
    //   1. currentProps = iModel.elements.getElementProps({ id, wantGeometry: true })
    //      → Gets current state WITH geometry (wantGeometry bypasses cache entirely)
    //   2. updateGeometry(currentProps, updatedProps):
    //      - If updatedProps.elementGeometryBuilderParams === undefined:
    //        → Calls geometryFromProps({ ...currentProps, ...updatedProps })
    //        → geometryFromProps uses props.intProperty (simulating "length") to build line
    //        → Sets updatedProps.elementGeometryBuilderParams
    //      - propsFromGeometry: derives EC props (like "bearing") from the geometry
    //   3. updatePlacement(currentProps, updatedProps):
    //      - If updatedProps.placement === undefined:
    //        → placementFromProps(currentProps.placement, updatedProps) derives placement
    //      - propsFromPlacement: syncs props from placement
    //
    // Flow:
    //   BasicManipulationCommand.updateGeometricElement() → first onUpdate
    //   BasicManipulationCommand.transformPlacement() → getElement(id) → second onUpdate
    //
    // The BUG: On the second onUpdate, getElementProps({ id, wantGeometry: true })
    // must return the state AFTER the first onUpdate's modifications. If it returns
    // stale data, geometryFromProps computes wrong geometry from wrong EC properties.

    let currentPropsSeenByHandler: any[] = [];

    (TestPhysicalObject as any).onUpdate = function (arg: OnElementPropsArg) {
      originalOnUpdate?.call(this, arg);
      const updatedProps = arg.props as Partial<GeometricElement3dProps> & { intProperty?: number };

      // --- Exact OpenSitePlus LineSegment.update() pattern ---
      // Step 1: Read current state WITH geometry (bypasses cache)
      const currentProps = arg.iModel.elements.getElementProps<GeometricElement3dProps & { intProperty?: number }>(
        { id: updatedProps.id ?? "", wantGeometry: true }
      );
      currentPropsSeenByHandler.push(JSON.parse(JSON.stringify(currentProps)));

      // Step 2: updateGeometry - simulates LineSegment.updateGeometry
      // If no elementGeometryBuilderParams provided by caller (normal case for transformPlacement):
      if (updatedProps.elementGeometryBuilderParams === undefined) {
        // geometryFromProps: Build geometry based on EC property (intProperty = "length")
        // Uses merged props: { ...currentProps, ...updatedProps }
        const mergedProps = { ...currentProps, ...updatedProps };
        const lineLength = mergedProps.intProperty ?? 10;

        // Build line from [0,0,0] to [length,0,0] in local coords
        const geomBuilder = new ElementGeometry.Builder();
        geomBuilder.appendGeometryQuery(LineSegment3d.create(Point3d.createZero(), new Point3d(lineLength, 0, 0)));
        (updatedProps as any).elementGeometryBuilderParams = { entryArray: geomBuilder.entries } as ElementGeometryBuilderParams;
      }

      // propsFromGeometry: derive "bearing" (stored in jsonProperties) from geometry
      if (!updatedProps.jsonProperties)
        updatedProps.jsonProperties = {};
      updatedProps.jsonProperties.derivedFromGeometry = {
        computedLength: (updatedProps as any).intProperty ?? (currentProps as any).intProperty ?? 0,
        handlerCall: onUpdateCallCount + 1,
      };

      // Step 3: updatePlacement - simulates Draft.updatePlacement
      if (updatedProps.placement === undefined) {
        // placementFromProps: derive placement from current placement + props
        updatedProps.placement = currentProps.placement;
      }

      // propsFromPlacement: sync userLabel from placement (simulates prop sync)
      updatedProps.userLabel = `line_${(updatedProps as any).intProperty ?? (currentProps as any).intProperty}_call${onUpdateCallCount + 1}`;

      onUpdateCallCount++;
    };

    await withEditTxn(imodel, "test OpenSitePlus LineSegment pattern", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;
      currentPropsSeenByHandler = [];

      // === BasicManipulationCommand.updateGeometricElement() ===
      // Frontend sends element with modified intProperty (simulates user editing "length")
      const elementForFirstUpdate = imodel.elements.getElement<TestPhysicalObject>(elementId);
      elementForFirstUpdate.intProperty = 42; // user changed "length" to 42
      txn.updateElement(elementForFirstUpdate.toJSON());
      // NO saveChanges - mirrors BasicManipulationCommand flow

      assert.equal(onUpdateCallCount, 1, "First onUpdate called");

      // First handler should have seen original intProperty=100 in currentProps (pre-update)
      assert.equal(currentPropsSeenByHandler[0].intProperty, 100,
        "First handler's getElementProps should see original intProperty=100 (update not persisted yet during onUpdate)");

      // === BasicManipulationCommand.transformPlacement() ===
      // Read element back (without wantGeometry - as transformPlacement does)
      const elementForPlacement = imodel.elements.getElement<GeometricElement>(elementId);

      // KEY ASSERTION: getElement must return first handler's modifications
      assert.equal(elementForPlacement.userLabel, "line_42_call1",
        "REGRESSION: After first onUpdate, getElement must return handler-modified userLabel");
      assert.equal((elementForPlacement as any).jsonProperties?.derivedFromGeometry?.computedLength, 42,
        "REGRESSION: jsonProperties.derivedFromGeometry.computedLength should be 42");

      // Transform placement (as transformPlacement does)
      const transform = Transform.createTranslationXYZ(10, 20, 0);
      elementForPlacement.placement.multiplyTransform(transform);

      // Second updateElement (note: elementForPlacement.toJSON() will NOT have
      // elementGeometryBuilderParams since it's not a persistent property)
      txn.updateElement(elementForPlacement.toJSON());

      assert.equal(onUpdateCallCount, 2, "Second onUpdate called");

      // === CRITICAL: Second handler's getElementProps({ wantGeometry: true }) ===
      // Must see the FIRST handler's intProperty=42 and its modifications
      assert.equal(currentPropsSeenByHandler[1].intProperty, 42,
        "REGRESSION (OpenSitePlus pattern): Second handler's getElementProps({ wantGeometry: true }) " +
        "MUST return intProperty=42 (set during first update). If this is 100, the first update's " +
        "EC property modifications are not visible to subsequent readInstance calls. " +
        "This causes geometryFromProps to compute geometry with wrong length.");

      assert.equal(currentPropsSeenByHandler[1].userLabel, "line_42_call1",
        "Second handler's getElementProps must see first handler's userLabel");

      assert.equal(currentPropsSeenByHandler[1].jsonProperties?.derivedFromGeometry?.computedLength, 42,
        "Second handler's getElementProps must see first handler's jsonProperties");

      txn.saveChanges("done");

      // Verify final state
      const finalEl = imodel.elements.getElement<TestPhysicalObject>(elementId);
      assert.equal(finalEl.intProperty, 42, "Final intProperty should be 42");
      assert.equal(finalEl.userLabel, "line_42_call2", "Final userLabel should reflect second handler call");
      assert.equal((finalEl as any).jsonProperties?.derivedFromGeometry?.computedLength, 42,
        "Final computedLength should still be 42");
      assert.equal((finalEl as any).jsonProperties?.derivedFromGeometry?.handlerCall, 2,
        "Final handlerCall should be 2");

      // Verify placement was transformed
      assert.approximately(finalEl.placement.origin.x, 11, 0.001, "Origin x should be 1+10=11");
      assert.approximately(finalEl.placement.origin.y, 22, 0.001, "Origin y should be 2+20=22");
    });
  });

  it("OpenSitePlus pattern: verify getElementProps with wantGeometry:true returns correct EC props after uncommitted update", async () => {
    // Isolated test focusing on the exact read path difference:
    // After updateElement (no saveChanges), does getElementProps({ id, wantGeometry: true })
    // return the updated EC properties?
    //
    // This isolates the read path from the handler complexity.

    installSimpleHandler(); // just modifies userLabel

    await withEditTxn(imodel, "test wantGeometry read path", async (txn) => {
      const elementId = txn.insertElement(makeElementProps());
      txn.saveChanges("insert");

      onUpdateCallCount = 0;

      // Update element - handler will set userLabel
      const el = imodel.elements.getElement<TestPhysicalObject>(elementId);
      el.intProperty = 999;
      txn.updateElement(el.toJSON());
      // NO saveChanges

      // Read with wantGeometry: true (bypasses cache - always fresh read)
      const propsWithGeom = imodel.elements.getElementProps<GeometricElement3dProps & { intProperty: number }>(
        { id: elementId, wantGeometry: true }
      );
      assert.equal(propsWithGeom.intProperty, 999,
        "getElementProps({ wantGeometry: true }) must return updated intProperty=999 even without saveChanges");
      assert.equal(propsWithGeom.userLabel, handlerLabel,
        "getElementProps({ wantGeometry: true }) must return handler-modified userLabel");
      assert.isDefined(propsWithGeom.geom,
        "getElementProps({ wantGeometry: true }) should include geometry");

      // Read without wantGeometry (may use cache)
      const propsNoGeom = imodel.elements.getElementProps<GeometricElement3dProps & { intProperty: number }>(elementId);
      assert.equal(propsNoGeom.intProperty, 999,
        "getElementProps(id) must also return updated intProperty=999");
      assert.equal(propsNoGeom.userLabel, handlerLabel,
        "getElementProps(id) must also return handler-modified userLabel");

      txn.saveChanges("done");
    });
  });
});
