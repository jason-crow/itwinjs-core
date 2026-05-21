/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import { assert, expect } from "chai";
import { Id64String } from "@itwin/core-bentley";
import { Code, CodeScopeSpec, DefinitionElementProps, IModel, PhysicalElementProps, SubCategoryAppearance } from "@itwin/core-common";
import { ChannelControl, DefinitionModel, DefinitionPartition, EditTxn, IModelJsFs, PhysicalModel, SnapshotDb, SpatialCategory } from "../../core-backend";
import { IModelTestUtils } from "../IModelTestUtils";
import { KnownTestLocations } from "../KnownTestLocations";
import { withEditTxn } from "../TestEditTxn";

describe("changeElementParent and changeElementModel", () => {
  let seedDb: SnapshotDb;
  let iModelDb: SnapshotDb;
  let modelAId: Id64String;
  let modelBId: Id64String;
  let defModelAId: Id64String;
  let defModelBId: Id64String;
  let categoryId: Id64String;
  let relatedElementCodeSpecId: Id64String;
  let modelScopedCodeSpecId: Id64String;
  let parentElementCodeSpecId: Id64String;
  let txn: EditTxn;

  before(async () => {
    IModelJsFs.recursiveMkDirSync(KnownTestLocations.outputDir);
    const seedFile = IModelTestUtils.prepareOutputFile("ChangeElementParentModel", "seed.bim");
    seedDb = SnapshotDb.createEmpty(seedFile, { rootSubject: { name: "ChangeElementParentModel" } });

    await withEditTxn(seedDb, "setup seed", async (editTxn) => {
      modelAId = PhysicalModel.insert(editTxn, IModel.rootSubjectId, "ModelA");
      modelBId = PhysicalModel.insert(editTxn, IModel.rootSubjectId, "ModelB");
      defModelAId = DefinitionModel.insert(editTxn, IModel.rootSubjectId, "DefinitionModelA");
      defModelBId = DefinitionModel.insert(editTxn, IModel.rootSubjectId, "DefinitionModelB");
      categoryId = SpatialCategory.insert(editTxn, IModel.dictionaryId, "TestCategory", new SubCategoryAppearance());
      relatedElementCodeSpecId = seedDb.codeSpecs.insert(editTxn, "RelatedElementCodeSpec", CodeScopeSpec.Type.RelatedElement);
      modelScopedCodeSpecId = seedDb.codeSpecs.insert(editTxn, "ModelScopedCodeSpec", CodeScopeSpec.Type.Model);
      parentElementCodeSpecId = seedDb.codeSpecs.insert(editTxn, "ParentElementCodeSpec", CodeScopeSpec.Type.ParentElement);
      assert.isNotEmpty(modelAId, "Expected a valid PhysicalModel id for ModelA");
      assert.isNotEmpty(modelBId, "Expected a valid PhysicalModel id for ModelB");
      assert.isNotEmpty(defModelAId, "Expected a valid DefinitionModel id for DefinitionModelA");
      assert.isNotEmpty(defModelBId, "Expected a valid DefinitionModel id for DefinitionModelB");
      assert.isNotEmpty(categoryId, "Expected a valid SpatialCategory id");
      assert.isNotEmpty(relatedElementCodeSpecId, "Expected a valid RelatedElement CodeSpec id");
      assert.isNotEmpty(modelScopedCodeSpecId, "Expected a valid Model CodeSpec id");
      assert.isNotEmpty(parentElementCodeSpecId, "Expected a valid ParentElement CodeSpec id");
    });
  });

  beforeEach(() => {
    iModelDb = SnapshotDb.createFrom(seedDb, IModelTestUtils.prepareOutputFile("ChangeElementParentModel", "ChangeElementParentModel.bim"));
    assert.isTrue(iModelDb.isOpen);
    txn = new EditTxn(iModelDb, "change element parent/model");
    txn.start();
    iModelDb.channels.addAllowedChannel(ChannelControl.sharedChannelName);
  });

  afterEach(() => {
    if (txn.isActive)
      txn.end("abandon");
    if (iModelDb.isOpen)
      iModelDb.close();
  });

  after(() => {
    if (seedDb.isOpen)
      seedDb.close();
  });

  const insertElement = (modelId: Id64String, opts: { parentId?: Id64String; codeSpec?: Id64String; codeScope?: Id64String; codeValue?: string } = {}): Id64String => {
    const { parentId, codeSpec, codeScope, codeValue } = opts;
    const props: PhysicalElementProps = {
      classFullName: "Generic:PhysicalObject",
      model: modelId,
      category: categoryId,
      code: codeSpec && codeScope && codeValue ? { spec: codeSpec, scope: codeScope, value: codeValue } : Code.createEmpty(),
      placement: { origin: [0, 0, 0], angles: { yaw: 0, pitch: 0, roll: 0 } },
      ...(parentId ? { parent: { id: parentId, relClassName: "BisCore:ElementOwnsChildElements" } } : {}),
    };
    const id = txn.insertElement(props);
    assert.isNotEmpty(id, "insertElement must return a valid ID");
    txn.saveChanges();
    return id;
  };

  describe("changeElementParent", () => {
    it("changes parent of a leaf element in the same model", () => {
      const parentA = insertElement(modelAId);
      const leaf = insertElement(modelAId, { parentId: parentA });
      const parentB = insertElement(modelAId);

      txn.changeElementParent({ id: leaf, parentId: parentB });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(leaf);
      assert.equal(moved.model, modelAId, "model should remain the same");
      assert.equal(moved.parent?.id, parentB, "parent should be updated to parentB");
    });

    it("changes parent to an element in a different model (cross-model parent change)", () => {
      const parentInA = insertElement(modelAId);
      const leaf = insertElement(modelAId, { parentId: parentInA });
      const targetInB = insertElement(modelBId);

      txn.changeElementParent({ id: leaf, parentId: targetInB });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(leaf);
      assert.equal(moved.model, modelBId, "model should change to ModelB");
      assert.equal(moved.parent?.id, targetInB, "parent should be updated to target in ModelB");
    });

    it("changes parent of a root element (no current parent) to a new parent in a different model", () => {
      const rootElem = insertElement(modelAId);
      const targetParent = insertElement(modelBId);

      txn.changeElementParent({ id: rootElem, parentId: targetParent });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(rootElem);
      assert.equal(moved.model, modelBId, "model should change to ModelB");
      assert.equal(moved.parent?.id, targetParent, "parent should be set to targetParent");
    });

    it("throws when element has children", () => {
      const parent = insertElement(modelAId);
      insertElement(modelAId, { parentId: parent }); // child
      const target = insertElement(modelBId);

      expect(() => txn.changeElementParent({ id: parent, parentId: target })).to.throw();
    });

    it("allows element with RelatedElement-scoped code", () => {
      const parentA = insertElement(modelAId);
      const leaf = insertElement(modelAId, {
        parentId: parentA,
        codeSpec: relatedElementCodeSpecId,
        codeScope: parentA,
        codeValue: "RelatedCode",
      });
      const parentB = insertElement(modelAId);

      txn.changeElementParent({ id: leaf, parentId: parentB });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(leaf);
      assert.equal(moved.parent?.id, parentB, "parent should be updated");
    });

    it("blocks element with ParentElement-scoped code (same model)", () => {
      const parentA = insertElement(modelAId);
      const leaf = insertElement(modelAId, {
        parentId: parentA,
        codeSpec: parentElementCodeSpecId,
        codeScope: parentA,
        codeValue: "ParentScopedCode",
      });
      const parentB = insertElement(modelAId);

      expect(() => txn.changeElementParent({ id: leaf, parentId: parentB })).to.throw();
    });

    it("blocks element with Model-scoped code when moving cross-model", () => {
      const leaf = insertElement(modelAId, {
        codeSpec: modelScopedCodeSpecId,
        codeScope: modelAId,
        codeValue: "ModelScopedCode",
      });
      const targetInB = insertElement(modelBId);

      expect(() => txn.changeElementParent({ id: leaf, parentId: targetInB })).to.throw();
    });

    it("allows element with Model-scoped code when staying in same model", () => {
      const parentA = insertElement(modelAId);
      const leaf = insertElement(modelAId, {
        parentId: parentA,
        codeSpec: modelScopedCodeSpecId,
        codeScope: modelAId,
        codeValue: "ModelScopedSameModel",
      });
      const parentB = insertElement(modelAId);

      txn.changeElementParent({ id: leaf, parentId: parentB });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(leaf);
      assert.equal(moved.parent?.id, parentB, "parent should be updated within same model");
    });

    it("rejects cross-model parent change when model types differ", () => {
      const physElem = insertElement(modelAId);
      const insertDefinitionElement = (modelId: Id64String, name: string): Id64String => {
        const props: DefinitionElementProps = {
          classFullName: "Generic:PhysicalType",
          model: modelId,
          code: { spec: relatedElementCodeSpecId, scope: modelId, value: name },
        };
        const id = txn.insertElement(props);
        txn.saveChanges();
        return id;
      };
      const defTarget = insertDefinitionElement(defModelAId, "DefTargetForPhys");

      expect(() => txn.changeElementParent({ id: physElem, parentId: defTarget })).to.throw("cannot move element from model of type");
    });
  });

  describe("changeElementModel", () => {
    it("changes model of a leaf element (becomes root in new model)", () => {
      const parent = insertElement(modelAId);
      const child = insertElement(modelAId, { parentId: parent });

      txn.changeElementModel({ id: child, modelId: modelBId });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(child);
      assert.equal(moved.model, modelBId, "model should change to ModelB");
      assert.isUndefined(moved.parent, "parent should be cleared (root in ModelB)");
    });

    it("changes model of a root element", () => {
      const elem = insertElement(modelAId);

      txn.changeElementModel({ id: elem, modelId: modelBId });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(elem);
      assert.equal(moved.model, modelBId, "model should change to ModelB");
      assert.isUndefined(moved.parent, "element should have no parent (root in ModelB)");
    });

    it("throws when element has children", () => {
      const parent = insertElement(modelAId);
      insertElement(modelAId, { parentId: parent }); // child

      expect(() => txn.changeElementModel({ id: parent, modelId: modelBId })).to.throw();
    });

    it("blocks element with Model-scoped code", () => {
      const elem = insertElement(modelAId, {
        codeSpec: modelScopedCodeSpecId,
        codeScope: modelAId,
        codeValue: "ModelScopedCode",
      });

      expect(() => txn.changeElementModel({ id: elem, modelId: modelBId })).to.throw();
    });

    it("blocks element with ParentElement-scoped code", () => {
      const parent = insertElement(modelAId);
      const elem = insertElement(modelAId, {
        parentId: parent,
        codeSpec: parentElementCodeSpecId,
        codeScope: parent,
        codeValue: "ParentScopedCode",
      });

      expect(() => txn.changeElementModel({ id: elem, modelId: modelBId })).to.throw();
    });

    it("allows element with RelatedElement-scoped code", () => {
      const scopeElem = insertElement(modelAId);
      const elem = insertElement(modelAId, {
        codeSpec: relatedElementCodeSpecId,
        codeScope: scopeElem,
        codeValue: "RelatedCode",
      });

      txn.changeElementModel({ id: elem, modelId: modelBId });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(elem);
      assert.equal(moved.model, modelBId, "model should change to ModelB");
    });

    it("allows element with empty code", () => {
      const elem = insertElement(modelAId);

      txn.changeElementModel({ id: elem, modelId: modelBId });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(elem);
      assert.equal(moved.model, modelBId, "model should change to ModelB");
    });

    it("rejects model change when model types differ", () => {
      const physElem = insertElement(modelAId);

      expect(() => txn.changeElementModel({ id: physElem, modelId: defModelAId })).to.throw("cannot move element from model of type");
    });

    it("throws when attempting to change model of a partition element", () => {
      expect(() => txn.changeElementModel({ id: modelAId, modelId: modelBId })).to.throw();
    });
  });

  describe("definition models", () => {
    const insertDefinitionElement = (modelId: Id64String, name: string, opts: { parentId?: Id64String } = {}): Id64String => {
      const props: DefinitionElementProps = {
        classFullName: "Generic:PhysicalType",
        model: modelId,
        code: { spec: relatedElementCodeSpecId, scope: modelId, value: name },
        ...(opts.parentId ? { parent: { id: opts.parentId, relClassName: "BisCore:ElementOwnsChildElements" } } : {}),
      };
      const id = txn.insertElement(props);
      assert.isNotEmpty(id, "insertDefinitionElement must return a valid ID");
      txn.saveChanges();
      return id;
    };

    it("changes parent of a definition element between definition models", () => {
      const defElem = insertDefinitionElement(defModelAId, "MovableCategoryA");
      const targetElem = insertDefinitionElement(defModelBId, "TargetInDefB");

      txn.changeElementParent({ id: defElem, parentId: targetElem });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(defElem);
      assert.equal(moved.model, defModelBId, "model should change to DefinitionModelB");
      assert.equal(moved.parent?.id, targetElem, "parent should be set to target in DefinitionModelB");
    });

    it("changes parent of a definition element to a different definition model as root via modeled element", () => {
      const defElem = insertDefinitionElement(defModelAId, "MovableCategoryB");

      // Target the modeled element (partition) of defModelB — element becomes root in that model
      const defModelBPartitionId = iModelDb.elements.queryElementIdByCode(
        DefinitionPartition.createCode(iModelDb, IModel.rootSubjectId, "DefinitionModelB"),
      )!;
      assert.isNotEmpty(defModelBPartitionId, "Expected to find DefinitionModelB partition element");

      txn.changeElementParent({ id: defElem, parentId: defModelBPartitionId });
      txn.saveChanges();

      const moved = iModelDb.elements.getElementProps(defElem);
      assert.equal(moved.model, defModelBId, "model should change to DefinitionModelB");
    });

    it("rejects changing parent of a physical element into a definition model", () => {
      const physElem = insertElement(modelAId);
      const defTarget = insertDefinitionElement(defModelAId, "DefTargetForPhys");

      expect(() => txn.changeElementParent({ id: physElem, parentId: defTarget })).to.throw("cannot move element from model of type");
    });

    it("rejects changing a physical element to a definition model", () => {
      const physElem = insertElement(modelAId);

      expect(() => txn.changeElementModel({ id: physElem, modelId: defModelAId })).to.throw("cannot move element from model of type");
    });

    it("rejects changing a definition element into a physical model", () => {
      const defElem = insertDefinitionElement(defModelAId, "DefElemToMoveToPhys");

      expect(() => txn.changeElementModel({ id: defElem, modelId: modelAId })).to.throw("cannot move element from model of type");
    });
  });

  describe("changeElementModel (assembly)", () => {
    it("moves an element with direct children to a new model", () => {
      const parent = insertElement(modelAId);
      const child1 = insertElement(modelAId, { parentId: parent });
      const child2 = insertElement(modelAId, { parentId: parent });
      txn.end("save");

      iModelDb.elements.changeElementModel({ id: parent, modelId: modelBId });

      const movedParent = iModelDb.elements.getElementProps(parent);
      const movedChild1 = iModelDb.elements.getElementProps(child1);
      const movedChild2 = iModelDb.elements.getElementProps(child2);

      assert.equal(movedParent.model, modelBId, "parent should be in ModelB");
      assert.equal(movedChild1.model, modelBId, "child1 should be in ModelB");
      assert.equal(movedChild2.model, modelBId, "child2 should be in ModelB");
      assert.equal(movedChild1.parent?.id, parent, "child1 should still be parented to the moved parent");
      assert.equal(movedChild2.parent?.id, parent, "child2 should still be parented to the moved parent");
    });

    it("moves an element with nested children (depth 2) to a new model", () => {
      const root = insertElement(modelAId);
      const child = insertElement(modelAId, { parentId: root });
      const grandchild = insertElement(modelAId, { parentId: child });
      txn.end("save");

      iModelDb.elements.changeElementModel({ id: root, modelId: modelBId });

      const movedRoot = iModelDb.elements.getElementProps(root);
      const movedChild = iModelDb.elements.getElementProps(child);
      const movedGrandchild = iModelDb.elements.getElementProps(grandchild);

      assert.equal(movedRoot.model, modelBId, "root should be in ModelB");
      assert.equal(movedChild.model, modelBId, "child should be in ModelB");
      assert.equal(movedGrandchild.model, modelBId, "grandchild should be in ModelB");
      assert.equal(movedChild.parent?.id, root, "child parent preserved");
      assert.equal(movedGrandchild.parent?.id, child, "grandchild parent preserved");
    });

    it("moves subtree when elements have empty codes (no scope conflict)", () => {
      const parent = insertElement(modelAId);
      const child1 = insertElement(modelAId, { parentId: parent });
      const child2 = insertElement(modelAId, { parentId: parent });
      txn.end("save");

      iModelDb.elements.changeElementModel({ id: parent, modelId: modelBId });

      const movedChild1 = iModelDb.elements.getElementProps(child1);
      const movedChild2 = iModelDb.elements.getElementProps(child2);
      assert.equal(movedChild1.model, modelBId);
      assert.equal(movedChild2.model, modelBId);
    });

    it("rejects moving a subtree to a different model type", () => {
      const parent = insertElement(modelAId);
      insertElement(modelAId, { parentId: parent });
      txn.end("save");

      expect(() => iModelDb.elements.changeElementModel({ id: parent, modelId: defModelAId })).to.throw("cannot move element from model of type");
    });
  });

  describe("changeElementParent (assembly)", () => {
    it("moves subtree to a target parent element in a different model", () => {
      const root = insertElement(modelAId);
      const child = insertElement(modelAId, { parentId: root });
      const targetParent = insertElement(modelBId);
      txn.end("save");

      iModelDb.elements.changeElementParent({ id: root, parentId: targetParent });

      const movedRoot = iModelDb.elements.getElementProps(root);
      const movedChild = iModelDb.elements.getElementProps(child);

      assert.equal(movedRoot.model, modelBId, "root should be in ModelB");
      assert.equal(movedRoot.parent?.id, targetParent, "root should be child of targetParent");
      assert.equal(movedChild.model, modelBId, "child should be in ModelB");
      assert.equal(movedChild.parent?.id, root, "child parent preserved");
    });

    it("moves subtree to a target parent in the same model", () => {
      const root = insertElement(modelAId);
      const child = insertElement(modelAId, { parentId: root });
      const targetParent = insertElement(modelAId);
      txn.end("save");

      iModelDb.elements.changeElementParent({ id: root, parentId: targetParent });

      const movedRoot = iModelDb.elements.getElementProps(root);
      const movedChild = iModelDb.elements.getElementProps(child);

      assert.equal(movedRoot.model, modelAId, "root should remain in ModelA");
      assert.equal(movedRoot.parent?.id, targetParent, "root should be child of targetParent");
      assert.equal(movedChild.model, modelAId, "child should remain in ModelA");
      assert.equal(movedChild.parent?.id, root, "child parent preserved");
    });

    it("moves a leaf element (no children) to a new parent", () => {
      const leaf = insertElement(modelAId);
      const targetParent = insertElement(modelBId);
      txn.end("save");

      iModelDb.elements.changeElementParent({ id: leaf, parentId: targetParent });

      const movedLeaf = iModelDb.elements.getElementProps(leaf);
      assert.equal(movedLeaf.model, modelBId, "leaf should be in ModelB");
      assert.equal(movedLeaf.parent?.id, targetParent, "leaf should be child of targetParent");
    });

    it("rejects making an element a child of its own descendant", () => {
      const grandparent = insertElement(modelAId);
      const parent = insertElement(modelAId, { parentId: grandparent });
      const child = insertElement(modelAId, { parentId: parent });
      txn.end("save");

      expect(() => iModelDb.elements.changeElementParent({ id: grandparent, parentId: child })).to.throw();
    });

    it("rejects making an element its own parent", () => {
      const elem = insertElement(modelAId);
      txn.end("save");

      expect(() => iModelDb.elements.changeElementParent({ id: elem, parentId: elem })).to.throw();
    });

    it("rejects moving a subtree to a different model type", () => {
      const parent = insertElement(modelAId);
      insertElement(modelAId, { parentId: parent });
      const targetParent = insertElement(defModelAId);
      txn.end("save");

      expect(() => iModelDb.elements.changeElementParent({ id: parent, parentId: targetParent })).to.throw("cannot move element from model of type");
    });
  });
});
