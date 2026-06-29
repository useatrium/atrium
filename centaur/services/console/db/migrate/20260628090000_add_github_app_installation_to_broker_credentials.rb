class AddGithubAppInstallationToBrokerCredentials < ActiveRecord::Migration[8.1]
  def change
    add_column :broker_credentials, :github_app_id, :string unless column_exists?(:broker_credentials, :github_app_id)
    unless column_exists?(:broker_credentials, :github_installation_id)
      add_column :broker_credentials, :github_installation_id, :string
    end
    add_column :broker_credentials, :github_private_key, :text unless column_exists?(:broker_credentials, :github_private_key)
    unless column_exists?(:broker_credentials, :github_private_key_id)
      add_column :broker_credentials, :github_private_key_id, :string
    end
  end
end
