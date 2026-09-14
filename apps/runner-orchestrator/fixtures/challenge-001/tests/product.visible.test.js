// tests/product.visible.test.js
const request = require("supertest");
const app = require("../backend/server");
const productsData = require("../backend/data/products");

describe("Product Management - Visible Tests", () => {
  beforeEach(() => {
    // Ensure clean state isolation before every test
    productsData.reset();
  });

  test("rejects fewer than 3 tags", async () => {
    const payload = {
      name: "Desk Mat",
      price: 25,
      tags: ["desk", "accessories"], // Only 2 tags
    };

    const res = await request(app).post("/api/products").send(payload);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "At least 3 tags are required",
    });
  });

  test("creates a product", async () => {
    const payload = {
      name: "4K Webcam",
      price: 89.99,
      tags: ["video", "streaming", "usb"],
    };

    const res = await request(app).post("/api/products").send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      name: "4K Webcam",
      price: 89.99,
      tags: ["video", "streaming", "usb"],
    });
  });

  test("stores tags correctly", async () => {
    const payload = {
      name: "Studio Microphone",
      price: 150,
      tags: ["audio", "studio", "pro"],
    };

    const postRes = await request(app).post("/api/products").send(payload);
    expect(postRes.status).toBe(201);

    const getRes = await request(app).get("/api/products");
    expect(getRes.status).toBe(200);

    const created = getRes.body.find((p) => p.name === "Studio Microphone");
    expect(created).toBeDefined();
    expect(created.tags).toEqual(["audio", "studio", "pro"]);
  });

  test("deletes a product", async () => {
    // Initial dataset contains products with IDs '1', '2', '3'
    const deleteRes = await request(app).delete("/api/products/2");

    expect(deleteRes.status).toBe(200);

    const getRes = await request(app).get("/api/products");
    expect(getRes.status).toBe(200);

    // Product 2 should be gone
    const product2 = getRes.body.find((p) => p.id === "2");
    expect(product2).toBeUndefined();

    // Remaining products ('1' and '3') should still exist!
    const remainingIds = getRes.body.map((p) => p.id);
    expect(remainingIds).toContain("1");
    expect(remainingIds).toContain("3");
    expect(getRes.body.length).toBe(2);
  });
});
