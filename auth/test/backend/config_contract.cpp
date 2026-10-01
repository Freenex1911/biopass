#include <yaml-cpp/yaml.h>

#include <cmath>
#include <stdexcept>

#include "auth_config.h"

void require(bool condition) {
  if (!condition)
    throw std::runtime_error("Configuration contract mismatch");
}
int main(int argc, char** argv) {
  require(argc == 2);
  const auto expected = YAML::LoadFile(argv[1]);
  const auto actual = biopass::readConfigFile(argv[1]);
  require(actual.schema_version == expected["schema_version"].as<int>());
  require(actual.appearance == expected["appearance"].as<std::string>());
  const auto strategy = expected["strategy"];
  require(actual.strategy.debug == strategy["debug"].as<bool>());
  require(actual.strategy.show_auth_status ==
          (strategy["show_auth_status"] ? strategy["show_auth_status"].as<bool>() : false));
  require(actual.strategy.execution_mode == strategy["execution_mode"].as<std::string>());
  require(actual.strategy.order == strategy["order"].as<std::vector<std::string>>());
  require(actual.strategy.ignore_services ==
          strategy["ignore_services"].as<std::vector<std::string>>());
  const auto face = expected["methods"]["face"];
  const auto& f = actual.methods.face;
  require(f.enable == face["enable"].as<bool>() && f.retries == face["retries"].as<unsigned>() &&
          f.retry_delay == face["retry_delay"].as<unsigned>());
  require(!f.camera && face["camera"].IsNull());
  require(f.detection.model_id == face["detection"]["model_id"].as<std::string>() &&
          f.detection.threshold == face["detection"]["threshold"].as<float>());
  require(f.recognition.model_id == face["recognition"]["model_id"].as<std::string>() &&
          f.recognition.threshold == face["recognition"]["threshold"].as<float>());
  const auto protection = face["anti_spoofing"];
  require(f.anti_spoofing.enable == protection["enable"].as<bool>());
  require(f.anti_spoofing.model.model_id == protection["model"]["model_id"].as<std::string>() &&
          f.anti_spoofing.model.threshold == protection["model"]["threshold"].as<float>());
  require(f.anti_spoofing.ir_camera == protection["ir_camera"].as<std::string>());
  require(f.anti_spoofing.ir_warmup_delay_ms == protection["ir_warmup_delay_ms"].as<int>() &&
          f.anti_spoofing.ir_presence_timeout_ms == protection["ir_presence_timeout_ms"].as<int>());
  const auto selection = face["camera_selection"];
  require(f.camera_selection.mode == (selection ? selection["mode"].as<std::string>() : "legacy"));
  require(f.camera_selection.pairs.size() == (selection ? selection["pairs"].size() : 0));
  if (selection) {
    require(f.camera_selection.fixed_pair == (selection["fixed_pair"].IsNull()
                                                  ? std::optional<std::string>{}
                                                  : selection["fixed_pair"].as<std::string>()));
    for (size_t i = 0; i < f.camera_selection.pairs.size(); ++i) {
      const auto pair = selection["pairs"][i];
      const auto& p = f.camera_selection.pairs[i];
      require(p.id == pair["id"].as<std::string>() && p.name == pair["name"].as<std::string>() &&
              p.camera == pair["camera"].as<std::string>() &&
              p.ir_camera == pair["ir_camera"].as<std::string>());
    }
  }
  const auto fingerprint = expected["methods"]["fingerprint"];
  require(actual.methods.fingerprint.enable == fingerprint["enable"].as<bool>() &&
          actual.methods.fingerprint.retries == fingerprint["retries"].as<unsigned>() &&
          actual.methods.fingerprint.timeout == fingerprint["timeout"].as<unsigned>());
}
