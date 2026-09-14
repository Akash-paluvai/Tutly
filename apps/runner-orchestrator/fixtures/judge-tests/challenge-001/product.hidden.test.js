// __hidden__/product.hidden.test.js
const request = require("supertest");
const app = require("../backend/server");
const productsData = require("../backend/data/products");

describe("Product Management - Hidden Judge Tests", () => {
  beforeEach(() => {
    // Ensure clean state isolation before every test
    productsData.reset();
  });

  test("product gets unique ID", async () => {
    const resA = await request(app)
      .post("/api/products")
      .send({
        name: "Item Alpha",
        price: 15,
        tags: ["alpha", "first", "batch"],
      });

    const resB = await request(app)
      .post("/api/products")
      .send({
        name: "Item Beta",
        price: 25,
        tags: ["beta", "second", "batch"],
      });

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.id).toBeDefined();
    expect(resB.body.id).toBeDefined();
    expect(resA.body.id).not.toBe(resB.body.id);
  });

  test("invalid product ID returns 404", async () => {
    const res = await request(app).delete("/api/products/non-existent-9999");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Product not found",
    });
  });

  test("deleted product cannot be retrieved", async () => {
    // Create a new product
    const createRes = await request(app)
      .post("/api/products")
      .send({
        name: "Temporary Item",
        price: 30,
        tags: ["temp", "disposable", "test"],
      });

    expect(createRes.status).toBe(201);
    const createdId = createRes.body.id;

    // Verify it exists in GET
    const getBefore = await request(app).get("/api/products");
    expect(getBefore.body.some((p) => p.id === createdId)).toBe(true);

    // Delete it
    const deleteRes = await request(app).delete(`/api/products/${createdId}`);
    expect(deleteRes.status).toBe(200);

    // Verify it cannot be retrieved in GET
    const getAfter = await request(app).get("/api/products");
    expect(getAfter.body.some((p) => p.id === createdId)).toBe(false);
  });

  test("malformed request is rejected", async () => {
    // Missing tags
    const resMissingTags = await request(app)
      .post("/api/products")
      .send({
        name: "No Tags Product",
        price: 50,
      });

    expect(resMissingTags.status).toBe(400);
    expect(resMissingTags.body).toEqual({
      error: "At least 3 tags are required",
    });

    // Tags is not an array
    const resInvalidType = await request(app)
      .post("/api/products")
      .send({
        name: "String Tag Product",
        price: 50,
        tags: "gadget, device, electronics",
      });

    expect(resInvalidType.status).toBe(400);
    expect(resInvalidType.body).toEqual({
      error: "At least 3 tags are required",
    });
  });
});
