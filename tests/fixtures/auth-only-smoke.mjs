import { mock } from "bun:test";
import * as pi from "@earendil-works/pi-ai";

const create = pi.createModels;
mock.module("@earendil-works/pi-ai", () => ({
  ...pi,
  createModels: () => {
    const models = create();
    models.login = async () => undefined;
    return models;
  },
}));
// Offline child: accidental network must fail before dispatch.
globalThis.fetch = () => { throw new Error("Offline smoke forbids network"); };
