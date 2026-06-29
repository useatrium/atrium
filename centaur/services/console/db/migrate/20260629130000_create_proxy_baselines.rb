class CreateProxyBaselines < ActiveRecord::Migration[8.1]
  def change
    create_table :proxy_baselines do |t|
      t.string :namespace, null: false, default: "default"
      t.string :foreign_id, null: false
      t.string :name, null: false
      t.jsonb :labels, null: false, default: {}
      t.jsonb :transforms, null: false, default: []
      t.references :created_by, null: false, foreign_key: { to_table: :users }
      t.timestamps
    end

    add_index :proxy_baselines, [ :namespace, :foreign_id ], unique: true
    add_index :proxy_baselines, :labels, using: :gin
  end
end
