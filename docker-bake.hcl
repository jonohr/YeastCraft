// Local builds only: no registry publication.
group "default" {
  targets = ["amd64", "arm64", "armv7"]
}
target "base" {
  context = "."
  dockerfile = "Dockerfile.rust"
}
target "amd64" {
  inherits = ["base"]
  platforms = ["linux/amd64"]
  tags = ["yeastcraft:local"]
}
target "arm64" {
  inherits = ["base"]
  platforms = ["linux/arm64"]
  tags = ["yeastcraft:arm64"]
}
target "armv7" {
  inherits = ["base"]
  platforms = ["linux/arm/v7"]
  tags = ["yeastcraft:armv7"]
}
