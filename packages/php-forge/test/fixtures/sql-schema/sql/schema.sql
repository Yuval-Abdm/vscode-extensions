CREATE TABLE `clients` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `nom` varchar(100) DEFAULT NULL,
  `solde` decimal(10,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE contrats (
  id int(11) NOT NULL,
  client_id int(11) NOT NULL,
  montant decimal(10,2) DEFAULT NULL
);
